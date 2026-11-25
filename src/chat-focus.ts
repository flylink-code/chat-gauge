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
 * We deliberately use explicit focus fields only:
 *   - `activeWorkspaceExecutionHostId` must not name a non-local host.
 *   - `activeWorkspaceKey` (or the exact `activeWorktreeId`) must be the
 *     requested workspace.
 *   - `activeTabId` must agree with the active tab group in `tabGroups`.
 *   - the tab must exist in `unifiedTabs[workspace]` as `agent-session`.
 * Never `lastFocusedAt`, file timestamps, `activeTabIdByWorktree` (observed
 * stale), process environment, or "latest active" heuristics.
 *
 * The Chat is only returned when it is also present in Orca's current agent
 * list for that exact workspace, so a stale/closed tab is not reported.
 */

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const WORKTREE_PREFIX = 'worktree:'

export type FocusedChatTab = { id: string; agent: string; tabId: string }

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

export type FocusDeps = {
  /** Exact `profile-state.db`. When omitted, `runCli` locates it through
   * `orca profile state exports --json`. */
  stateFile?: string
  /** Required when `stateFile` is omitted. */
  runCli?: FocusCliRunner
  /** Current chats for the exact workspace (reuse `source.listChats`). */
  listChats: FocusChatLister
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** UI keys for Git worktrees have no `worktree:` prefix in `unifiedTabs` and
 * `tabGroups`; `activeWorkspaceKey` does. Folder keys are `folder:<uuid>` in
 * both. Comparing the unprefixed form accepts either spelling without
 * resolving selectors (an exact id is required). */
const plainKey = (value: string): string =>
  value.startsWith(WORKTREE_PREFIX) ? value.slice(WORKTREE_PREFIX.length) : value

/** Pure selection over one persisted `workspaceSession` payload. */
export function selectFocusedChatTab(session: unknown, workspaceId: string): FocusedChatTab | null {
  if (!isRecord(session) || typeof workspaceId !== 'string' || !workspaceId) return null
  // Orca treats a missing execution host as local; a named non-local host is
  // rejected. The chat list below is still local-only.
  if (typeof session.activeWorkspaceExecutionHostId === 'string' && session.activeWorkspaceExecutionHostId !== 'local') return null

  const activeWorkspaceKey = typeof session.activeWorkspaceKey === 'string'
    ? session.activeWorkspaceKey
    : typeof session.activeWorktreeId === 'string'
      ? session.activeWorktreeId
      : ''
  if (!activeWorkspaceKey || plainKey(activeWorkspaceKey) !== plainKey(workspaceId)) return null

  const key = plainKey(workspaceId)
  const activeTabId = typeof session.activeTabId === 'string' ? session.activeTabId : ''
  if (!activeTabId) return null

  const tabTypes = isRecord(session.activeTabTypeByWorktree) ? session.activeTabTypeByWorktree : null
  if (tabTypes && typeof tabTypes[key] === 'string' && tabTypes[key] !== 'agent-session') return null

  // The active group's tab is the canonical active tab. A disagreement with
  // the top-level activeTabId means the persisted state is inconsistent, so
  // return nothing rather than pick one.
  const activeGroupIds = isRecord(session.activeGroupIdByWorktree) ? session.activeGroupIdByWorktree : null
  const activeGroupId = activeGroupIds && typeof activeGroupIds[key] === 'string' ? activeGroupIds[key] : null
  if (activeGroupId) {
    const groups = isRecord(session.tabGroups) ? session.tabGroups[key] : null
    if (!Array.isArray(groups)) return null
    const group = groups.find((row) => isRecord(row) && row.id === activeGroupId)
    if (!isRecord(group)) return null
    if (group.activeTabId !== activeTabId) return null
  }

  const tabs = isRecord(session.unifiedTabs) ? session.unifiedTabs[key] : null
  if (!Array.isArray(tabs)) return null
  const tab = tabs.find((row) => isRecord(row) && row.id === activeTabId)
  if (!isRecord(tab)) return null
  if (tab.contentType !== 'agent-session') return null
  if (tab.executionHostId !== undefined && tab.executionHostId !== 'local') return null

  const agent = typeof tab.agentSessionAgent === 'string' ? tab.agentSessionAgent : ''
  if (!agent) return null

  const entityId = typeof tab.entityId === 'string' ? tab.entityId : ''
  const id = UUID.test(entityId)
    ? entityId
    : (() => {
        const raw = typeof tab.id === 'string' ? tab.id.replace(/^structured-agent-session-/, '') : ''
        return UUID.test(raw) ? raw : null
      })()
  if (!id) return null

  return { id, agent, tabId: activeTabId }
}

/** Reads the persisted session payload read-only. Any missing/broken state is
 * treated as "no focused Chat" rather than an error. */
async function readWorkspaceSession(stateFile: string): Promise<unknown> {
  if (typeof stateFile !== 'string' || !stateFile) return null
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(stateFile, { readOnly: true })
    try {
      const row = db
        .prepare("SELECT payload FROM profile_state_documents WHERE domain = 'workspaceSession'")
        .get() as { payload?: unknown } | undefined
      return typeof row?.payload === 'string' ? JSON.parse(row.payload) : null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

/** Uses Orca's public CLI to ask which SQLite file the active profile uses,
 * so callers do not guess APPDATA/profile-directory layouts. */
async function resolveStateFile(runCli: FocusCliRunner | undefined): Promise<string | null> {
  if (!runCli) {
    throw new TypeError('discoverFocusedChat requires stateFile or runCli')
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
 * `workspaceId` must be the exact id from `workspace.readContext()` (or an
 * exact worktree id); selectors such as `active` are not resolved.
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

  const stateFile = deps.stateFile ?? (await resolveStateFile(deps.runCli))
  if (!stateFile) return null

  const tab = selectFocusedChatTab(await readWorkspaceSession(stateFile), workspaceId)
  if (!tab) return null

  let chats: Awaited<ReturnType<FocusChatLister>>
  try {
    chats = await deps.listChats(plainKey(workspaceId))
  } catch {
    return null
  }
  const listed = chats.find((chat) => chat && chat.id === tab.id)
  if (!listed) return null
  if (typeof listed.agent === 'string' && listed.agent && listed.agent !== tab.agent) return null
  return tab.id
}
