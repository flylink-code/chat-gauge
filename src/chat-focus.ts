/**
 * Finds the native Chat the user is actually looking at.
 *
 * Orca 1.4.274 has no CLI or plugin-host field that names a focused Chat:
 * `orca tab list` only covers browser tabs, `orca terminal list
 * --include-visual-layouts` only covers terminal panes (native Chats are not
 * terminals), and `orca agent list` / `orca agent show` name a Chat's places
 * but never which one is focused. The one real source is the local UI state
 * Orca persists in `profile-state.db` → `profile_state_documents` →
 * `workspaceSession`.
 *
 * The canonical active tab is the **active group's** `activeTabId`:
 *   - `activeGroupIdByWorktree[workspace]` picks the group (falling back to
 *     the first group only when no group is recorded); a dangling recorded id
 *     is inconsistent state, not a reason to pick another group.
 *   - the group's `activeTabId` must name a tab in `unifiedTabs[workspace]`
 *     whose `groupId` is that group.
 *   - `activeTabTypeByWorktree` agrees with that tab in normal states but is
 *     derived, so it never overrides the group.
 * Never `activeTabId` (the terminal-surface id, null while a Chat is in front),
 * `activeTabIdByWorktree` (also terminal surface), `lastFocusedAt`, file
 * timestamps, process environment, or "latest active" heuristics.
 *
 * Workspace identity:
 *   - Folder workspaces use `folder:<uuid>` in the session and in
 *     `workspace.readContext()`.
 *   - Worktree session keys are the raw `repoId::path`; the active pointer is
 *     spelled `worktree:<repoId::path>`.
 *   - `workspace.readContext()` returns `identity:wt2:<host>:<instanceId>` for
 *     worktrees that have a durable identity. `worktreeMeta` /
 *     `worktreeIdentityAliases` translate between the two. The live chat list
 *     is the independent cross-check: callers confirm the observed Chat with
 *     `listChats(observation.workspaceId)` before trusting it.
 *
 * Local-only boundary: a native Chat observed here runs on this machine. A
 * non-local `activeWorkspaceExecutionHostId` is rejected before any match, and
 * a tab with an explicit foreign `executionHostId` is rejected too. Remote
 * hosts keep their rows in `workspaceSessionsByHostId` partitions; those are
 * deliberately not treated as local focus.
 *
 * Persistence lag: Orca debounces renderer session writes (~150 ms) and can
 * defer them, so this file is a snapshot, not live UI state. An observation can
 * therefore disagree with `workspace.readContext()`; callers treat it as a
 * candidate and validate it against the live roster. Only the derived focus is
 * cached (keyed by document revisions): the payload, which holds scrollback,
 * is parsed on a miss and never retained.
 */

import type { DatabaseSync } from 'node:sqlite'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const WORKTREE_PREFIX = 'worktree:'
const FOLDER_PREFIX = 'folder:'
const ID_PREFIX = 'id:'
const IDENTITY_PREFIX = 'identity:'
const STRUCTURED_TAB_PREFIX = 'structured-agent-session-'
const LOCAL_HOST = 'local'
const HOST_SEPARATOR = '|'
const IDENTITY_KEY_PREFIX = 'wt2:'
const FOCUS_CACHE_LIMIT = 32

export type FocusedChatTab = { id: string; agent: string; tabId: string }

/** A selected native Chat before any roster lookup. `workspaceId` is the
 * exact selector `listChats` accepts: `identity:<key>`, `folder:<id>`, or the
 * raw `repoId::path` worktree id. */
export type NativeChatFocus = { workspaceId: string; id: string; agent: string }

/** Runs the Orca CLI and resolves its stdout. Wire this to the same runner
 * `src/source.ts` uses (strips ORCA_* and ELECTRON_RUN_AS_NODE, sets APPDATA and
 * locates the packaged orca.exe), returning only stdout. */
export type FocusCliRunner = (
  args: readonly string[],
  options?: { timeoutMs?: number }
) => Promise<string>

/** `src/source.ts#listChats`, injected so this module does not duplicate the
 * CLI invocation or its local/chat/UUID filtering. */
export type FocusChatLister = (
  workspaceId: string
) => Promise<ReadonlyArray<{ id: string; agent?: string }>>

export type FocusStateDeps = {
  /** Exact `profile-state.db`. When omitted, `runCli` locates it through
   * `orca profile state exports --json`. */
  stateFile?: string
  /** Required when `stateFile` is omitted. */
  runCli?: FocusCliRunner
}

export type FocusDeps = FocusStateDeps & {
  /** Current chats for the exact workspace (reuse `source.listChats`). */
  listChats: FocusChatLister
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `worktree:<raw>` is the active-pointer spelling; session maps are keyed by
 * the raw `repoId::path`. Folder keys are `folder:<uuid>` in both. */
const stripWorktreePrefix = (value: string): string =>
  value.startsWith(WORKTREE_PREFIX) ? value.slice(WORKTREE_PREFIX.length) : value

/** Mirrors Orca's `parseExecutionHostId` canonical form. Missing is local; an
 * unknown non-empty host is not trusted. */
function canonicalHostId(value: string): string | null {
  const normalized = value.trim()
  if (!normalized) return null
  if (normalized === LOCAL_HOST) return LOCAL_HOST
  for (const prefix of ['ssh:', 'runtime:'] as const) {
    if (!normalized.startsWith(prefix)) continue
    const encoded = normalized.slice(prefix.length)
    if (!encoded || encoded.includes(HOST_SEPARATOR)) return null
    try {
      const decoded = decodeURIComponent(encoded)
      return decoded ? `${prefix}${encodeURIComponent(decoded)}` : null
    } catch {
      return null
    }
  }
  return null
}

function identityParts(value: string): { host: string; key: string } | null {
  if (!value.startsWith(IDENTITY_KEY_PREFIX)) return null
  const rest = value.slice(IDENTITY_KEY_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator <= 0) return null
  let host: string
  let instanceId: string
  try {
    host = decodeURIComponent(rest.slice(0, separator))
    instanceId = decodeURIComponent(rest.slice(separator + 1))
  } catch {
    return null
  }
  const canonicalHost = canonicalHostId(host)
  return canonicalHost && instanceId
    ? {
        host: canonicalHost,
        key: `${IDENTITY_KEY_PREFIX}${encodeURIComponent(canonicalHost)}:${encodeURIComponent(instanceId)}`
      }
    : null
}

function canonicalIdentityKey(value: string): string | null {
  return identityParts(value)?.key ?? null
}

function identityFromMetaRow(row: unknown): string | null {
  if (!isRecord(row) || typeof row.instanceId !== 'string' || !row.instanceId) return null
  if (typeof row.hostId !== 'string') return null
  const host = canonicalHostId(row.hostId)
  return host ? `${IDENTITY_KEY_PREFIX}${encodeURIComponent(host)}:${encodeURIComponent(row.instanceId)}` : null
}

type Stamp = { revision: number; updatedAt: number }
/** `undefined` means the document has no cacheable revision columns. */
type StampResult = Stamp | null | undefined

function readStamp(db: DatabaseSync, domain: string): StampResult {
  try {
    const row = db
      .prepare('SELECT revision, updated_at FROM profile_state_documents WHERE domain = ?')
      .get(domain) as Record<string, unknown> | undefined
    if (!row) return null
    if (typeof row.revision !== 'number' || typeof row.updated_at !== 'number') return undefined
    return { revision: row.revision, updatedAt: row.updated_at }
  } catch {
    return undefined
  }
}

/** Reads one payload for derivation. The parsed value is never cached. */
function readDocument(db: DatabaseSync, domain: string): unknown {
  let row: Record<string, unknown> | undefined
  try {
    row = db
      .prepare('SELECT payload FROM profile_state_documents WHERE domain = ?')
      .get(domain) as Record<string, unknown> | undefined
  } catch {
    return null
  }
  if (!row || typeof row.payload !== 'string') return null
  try {
    return JSON.parse(row.payload)
  } catch {
    return null
  }
}

async function withDatabase<T>(
  stateFile: string,
  read: (db: DatabaseSync) => T
): Promise<T | null> {
  try {
    const { DatabaseSync: Sqlite } = await import('node:sqlite')
    const db = new Sqlite(stateFile, { readOnly: true })
    try {
      return read(db)
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

/** Mirrors `getActiveSidebarWorkspaceId`: the scoped key wins, the legacy id is
 * the fallback. Missing host means local; a foreign or malformed host rejects
 * the focus outright. */
function activeWorkspace(session: Record<string, unknown>): { key: string } | null {
  const rawKey =
    typeof session.activeWorkspaceKey === 'string' && session.activeWorkspaceKey
      ? session.activeWorkspaceKey
      : typeof session.activeWorktreeId === 'string'
        ? session.activeWorktreeId
        : ''
  const key = stripWorktreePrefix(rawKey)
  if (!key) return null
  const rawHost = session.activeWorkspaceExecutionHostId
  if (rawHost === undefined || rawHost === null || rawHost === '') return { key }
  if (typeof rawHost !== 'string') return null
  return canonicalHostId(rawHost) === LOCAL_HOST ? { key } : null
}

/** Absent means the tab's owner is this workspace's host; an explicit host
 * must be local. Foreign partitions are never eligible here. */
function tabIsLocal(tab: Record<string, unknown>): boolean {
  const raw = tab.executionHostId
  if (raw === undefined || raw === null) return true
  return typeof raw === 'string' && canonicalHostId(raw) === LOCAL_HOST
}

/** Pure selection over one persisted local session payload. */
export function selectFocusedChatTab(session: unknown, workspaceId: string): FocusedChatTab | null {
  if (!isRecord(session) || typeof workspaceId !== 'string' || !workspaceId) return null
  const active = activeWorkspace(session)
  if (!active) return null
  const requested = normalizeRequestedWorkspace(workspaceId)
  if (!requested || requested.identity || requested.key !== active.key) return null
  return selectCanonicalTab(session, active.key)
}

function normalizeRequestedWorkspace(
  workspaceId: string
): { key: string; identity?: undefined } | { identity: string; key?: undefined } | null {
  if (typeof workspaceId !== 'string') return null
  const value = workspaceId.trim()
  if (!value) return null
  if (value.startsWith(IDENTITY_PREFIX)) {
    const identity = value.slice(IDENTITY_PREFIX.length)
    return identity ? { identity } : null
  }
  if (value.startsWith(ID_PREFIX)) {
    const key = stripWorktreePrefix(value.slice(ID_PREFIX.length))
    return key ? { key } : null
  }
  const key = stripWorktreePrefix(value)
  return key ? { key } : null
}

function selectCanonicalTab(rows: Record<string, unknown>, key: string): FocusedChatTab | null {
  const groups = isRecord(rows.tabGroups) ? rows.tabGroups[key] : null
  if (!Array.isArray(groups)) return null
  const activeGroupIds = isRecord(rows.activeGroupIdByWorktree)
    ? rows.activeGroupIdByWorktree
    : null
  const recordedGroupId =
    activeGroupIds && typeof activeGroupIds[key] === 'string' ? activeGroupIds[key] : ''
  // A recorded id that no longer exists is inconsistent state. Only an absent
  // id falls back to the first group (matching Orca's surface derivation).
  const group = recordedGroupId
    ? groups.find((candidate) => isRecord(candidate) && candidate.id === recordedGroupId)
    : groups[0]
  if (!isRecord(group) || typeof group.id !== 'string') return null

  const activeTabId = typeof group.activeTabId === 'string' ? group.activeTabId : ''
  if (!activeTabId) return null

  const tabs = isRecord(rows.unifiedTabs) ? rows.unifiedTabs[key] : null
  if (!Array.isArray(tabs)) return null
  const tab = tabs.find((candidate) => isRecord(candidate) && candidate.id === activeTabId)
  if (!isRecord(tab)) return null
  if (tab.groupId !== group.id) return null
  if (tab.contentType !== 'agent-session') return null
  if (!tabIsLocal(tab)) return null

  const agent = typeof tab.agentSessionAgent === 'string' ? tab.agentSessionAgent : ''
  if (!agent) return null

  const entityId = typeof tab.entityId === 'string' ? tab.entityId : ''
  const prefixedId =
    typeof tab.id === 'string' && tab.id.startsWith(STRUCTURED_TAB_PREFIX)
      ? tab.id.slice(STRUCTURED_TAB_PREFIX.length)
      : ''
  let id: string | null = null
  if (UUID.test(entityId)) {
    // A structured tab's id suffix is the same session; disagreement is corrupt.
    if (UUID.test(prefixedId) && prefixedId !== entityId) return null
    id = entityId
  } else if (UUID.test(prefixedId)) {
    id = prefixedId
  } else if (typeof tab.id === 'string' && UUID.test(tab.id)) {
    id = tab.id
  }
  if (!id) return null

  return { id, agent, tabId: activeTabId }
}

/** Local identity keys for one raw worktree id. A foreign identity is not a
 * candidate: this module observes local native Chats only. */
function localIdentityKeys(
  worktreeKey: string,
  meta: unknown,
  aliases: unknown
): { preferred: string | null; all: string[] } {
  const direct = isRecord(meta) ? identityFromMetaRow(meta[worktreeKey]) : null
  const identities = new Set<string>()
  if (direct && identityParts(direct)?.host === LOCAL_HOST) identities.add(direct)
  if (isRecord(aliases)) {
    for (const [alias, values] of Object.entries(aliases)) {
      const separator = alias.indexOf(HOST_SEPARATOR)
      if (separator <= 0 || alias.slice(separator + 1) !== worktreeKey) continue
      if (canonicalHostId(alias.slice(0, separator)) !== LOCAL_HOST) continue
      if (!Array.isArray(values)) continue
      for (const value of values) {
        if (typeof value !== 'string') continue
        const canonical = canonicalIdentityKey(value)
        if (canonical && identityParts(value)?.host === LOCAL_HOST) identities.add(canonical)
      }
    }
  }
  const all = [...identities]
  const preferred = direct && identities.has(direct) ? direct : all.length === 1 ? all[0]! : null
  return { preferred, all }
}

type Selection = FocusedChatTab & { rawKey: string }
type LoadedFocus = Selection & { identity: string | null; identityKeys: string[] }
type IdentityData = { identity: string | null; identityKeys: string[] }

type SelectionCacheEntry = { stamp: StampResult; selection: Selection | null }
type IdentityCacheEntry = { metaStamp: StampResult; aliasStamp: StampResult; data: IdentityData }
const selectionCache = new Map<string, SelectionCacheEntry>()
const identityCache = new Map<string, IdentityCacheEntry>()

function sameStamp(left: StampResult, right: StampResult): boolean {
  if (left === undefined || right === undefined) return false
  if (left === null || right === null) return left === right
  return left.revision === right.revision && left.updatedAt === right.updatedAt
}

function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  cache.set(key, value)
  if (cache.size > FOCUS_CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (typeof oldest === 'string') cache.delete(oldest)
  }
  return value
}

/** Derives only the selected tab; the parsed payload is released here. */
function deriveSelection(db: DatabaseSync): Selection | null {
  const local = readDocument(db, 'workspaceSession')
  if (!isRecord(local)) return null
  const active = activeWorkspace(local)
  if (!active) return null
  const tab = selectCanonicalTab(local, active.key)
  return tab ? { ...tab, rawKey: active.key } : null
}

function loadIdentity(
  db: DatabaseSync,
  stateFile: string,
  rawKey: string
): IdentityData {
  const metaStamp = readStamp(db, 'worktreeMeta')
  const aliasStamp = readStamp(db, 'worktreeIdentityAliases')
  const key = `${stateFile}\0${rawKey}`
  const cached = identityCache.get(key)
  if (cached && sameStamp(cached.metaStamp, metaStamp) && sameStamp(cached.aliasStamp, aliasStamp)) {
    return cached.data
  }
  const derived = localIdentityKeys(
    rawKey,
    readDocument(db, 'worktreeMeta'),
    readDocument(db, 'worktreeIdentityAliases')
  )
  const data = { identity: derived.preferred, identityKeys: derived.all }
  remember(identityCache, key, { metaStamp, aliasStamp, data })
  return data
}

async function loadFocus(stateFile: string): Promise<LoadedFocus | null> {
  return withDatabase(stateFile, (db) => {
    const sessionStamp = readStamp(db, 'workspaceSession')
    const cached = selectionCache.get(stateFile)
    let selection: Selection | null
    if (cached && sameStamp(cached.stamp, sessionStamp)) {
      selection = cached.selection
    } else {
      selection = deriveSelection(db)
      remember(selectionCache, stateFile, { stamp: sessionStamp, selection })
    }
    if (!selection) return null
    if (selection.rawKey.startsWith(FOLDER_PREFIX)) {
      return { ...selection, identity: null, identityKeys: [] }
    }
    return { ...selection, ...loadIdentity(db, stateFile, selection.rawKey) }
  })
}

function workspaceSelector(focus: LoadedFocus): string {
  return focus.identity ? `${IDENTITY_PREFIX}${focus.identity}` : focus.rawKey
}

function matchesRequestedWorkspace(workspaceId: string, focus: LoadedFocus): boolean {
  const requested = normalizeRequestedWorkspace(workspaceId)
  if (!requested) return false
  if (requested.identity) {
    const canonical = canonicalIdentityKey(requested.identity)
    return Boolean(canonical) && focus.identityKeys.includes(canonical!)
  }
  return requested.key === focus.rawKey
}

/** The selector `listChats` receives: bare raw ids and `folder:`/`identity:`
 * selectors are native; only the active-pointer `worktree:` spelling is
 * stripped. */
function chatListSelector(workspaceId: string): string {
  return stripWorktreePrefix(workspaceId)
}

/**
 * Reads persisted desktop focus without any roster lookup.
 *
 * Returns the exact workspace selector (`identity:` when resolvable, else the
 * raw worktree id or `folder:` key), the Orca session id and the agent. It can
 * disagree with live `workspace.readContext()` while Orca's debounced session
 * write is pending; callers compare it and validate with
 * `confirmNativeChatFocus` / their own `listChats(observation.workspaceId)`.
 */
export async function observeNativeChatFocus(
  deps: FocusStateDeps
): Promise<NativeChatFocus | null> {
  if (!deps || (typeof deps.stateFile !== 'string' && typeof deps.runCli !== 'function')) {
    throw new TypeError('observeNativeChatFocus requires stateFile or runCli')
  }
  const stateFile = deps.stateFile || (await resolveStateFile(deps.runCli))
  if (!stateFile) return null
  const focus = await loadFocus(stateFile)
  if (!focus) return null
  return { workspaceId: workspaceSelector(focus), id: focus.id, agent: focus.agent }
}

/** Validates an observation against the live roster for its exact workspace.
 * The roster is the independent check that an identity alias (or a lagged
 * session snapshot) still names this Chat. */
export async function confirmNativeChatFocus(
  focus: Pick<NativeChatFocus, 'workspaceId' | 'id' | 'agent'>,
  listChats: FocusChatLister
): Promise<string | null> {
  if (
    !isRecord(focus) ||
    typeof focus.workspaceId !== 'string' ||
    !focus.workspaceId ||
    typeof focus.id !== 'string' ||
    !UUID.test(focus.id) ||
    typeof focus.agent !== 'string' ||
    !focus.agent ||
    typeof listChats !== 'function'
  ) {
    return null
  }
  let chats: Awaited<ReturnType<FocusChatLister>>
  try {
    chats = await listChats(chatListSelector(focus.workspaceId))
  } catch {
    return null
  }
  const listed = chats.find((chat) => chat && chat.id === focus.id)
  if (!listed) return null
  if (typeof listed.agent === 'string' && listed.agent && listed.agent !== focus.agent) return null
  return focus.id
}

/** Uses Orca's public CLI to ask which SQLite file the active profile uses,
 * so callers do not guess APPDATA/profile-directory layouts. */
async function resolveStateFile(runCli: FocusCliRunner | undefined): Promise<string | null> {
  if (!runCli) {
    throw new TypeError('observeNativeChatFocus requires stateFile or runCli')
  }
  try {
    const stdout = await runCli(['profile', 'state', 'exports', '--json'], { timeoutMs: 3500 })
    const data: unknown = JSON.parse(stdout)
    if (!isRecord(data) || data.ok !== true || !isRecord(data.result)) return null
    const file = data.result.databaseFile
    return typeof file === 'string' && file ? file : null
  } catch {
    return null
  }
}

/**
 * Resolves the exact workspace's focused native Chat id, or null when no
 * native Chat is focused, when the focused workspace is not `workspaceId`, or
 * when the Chat is no longer listed for that workspace.
 *
 * `workspaceId` must be the exact id from `workspace.readContext()` (a
 * `folder:` key, an `identity:` key, or an exact worktree id). The roster
 * lookup always uses the observed exact selector, so an `identity:` alias is
 * cross-checked against the live chat list rather than trusted on its own.
 */
export async function discoverFocusedChat(
  workspaceId: string,
  deps: FocusDeps
): Promise<string | null> {
  if (typeof deps?.listChats !== 'function') {
    throw new TypeError('discoverFocusedChat requires listChats')
  }
  if (!deps.stateFile && !deps.runCli) {
    throw new TypeError('discoverFocusedChat requires stateFile or runCli')
  }

  const stateFile = deps.stateFile || (await resolveStateFile(deps.runCli))
  if (!stateFile) return null

  const focus = await loadFocus(stateFile)
  if (!focus || !matchesRequestedWorkspace(workspaceId, focus)) return null

  const requested = normalizeRequestedWorkspace(workspaceId)
  // An identity request is confirmed through the identity selector itself, so
  // the alias translation is checked by the host, not merely by this file.
  const selector = requested?.identity
    ? `${IDENTITY_PREFIX}${requested.identity}`
    : workspaceSelector(focus)
  return confirmNativeChatFocus(
    { workspaceId: selector, id: focus.id, agent: focus.agent },
    deps.listChats
  )
}
