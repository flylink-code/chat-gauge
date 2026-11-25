import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assert, test } from 'orca/testing'
import {
  discoverFocusedChat,
  selectFocusedChatTab,
  type FocusDeps
} from './chat-focus'

const ws = 'folder:11111111-1111-1111-1111-111111111111'
const otherWs = 'folder:33333333-3333-3333-3333-333333333333'
const chat = '22222222-2222-2222-2222-222222222222'
const otherChat = '44444444-4444-4444-4444-444444444444'
const tabId = `structured-agent-session-${chat}`
const otherTabId = `structured-agent-session-${otherChat}`
const legacyChat = 'claude_48975af4_8a54_4674_bb40_742b0950bdae'
const legacyTabId = `structured-agent-session-${legacyChat}`

type Tab = {
  id: string
  entityId?: string
  contentType?: string
  executionHostId?: string
  agentSessionAgent?: string
  lastFocusedAt?: number
}

const tab = (overrides: Partial<Tab> = {}): Tab => ({
  id: tabId,
  entityId: chat,
  contentType: 'agent-session',
  executionHostId: 'local',
  agentSessionAgent: 'claude',
  ...overrides
})

const session = (overrides: Record<string, unknown> = {}) => ({
  activeWorkspaceExecutionHostId: 'local',
  activeWorkspaceKey: `worktree:${ws}`,
  activeTabId: tabId,
  activeTabTypeByWorktree: { [ws]: 'agent-session', [otherWs]: 'terminal' },
  activeGroupIdByWorktree: { [ws]: 'group-1' },
  tabGroups: { [ws]: [{ id: 'group-1', activeTabId: tabId }] },
  // Deliberately stale in some Orca states; it must never drive selection.
  activeTabIdByWorktree: { [ws]: otherTabId },
  unifiedTabs: {
    [ws]: [tab(), tab({ id: otherTabId, entityId: otherChat })],
    [otherWs]: [tab({ id: otherTabId, entityId: otherChat })]
  },
  ...overrides
})

const createState = async (payload: unknown) => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-focus-'))
  const file = join(dir, 'profile-state.db')
  const db = new DatabaseSync(file)
  try {
    db.exec('CREATE TABLE profile_state_documents (domain TEXT PRIMARY KEY, payload TEXT NOT NULL)')
    db.prepare('INSERT INTO profile_state_documents VALUES (?, ?)').run('workspaceSession', JSON.stringify(payload))
  } finally { db.close() }
  return { dir, file }
}

const chats = [{ id: chat, agent: 'claude' }]

test('selects the active native Chat, never the last-focused or stale per-worktree tab', () => {
  // Put a huge lastFocusedAt on the inactive Chat and a stale activeTabIdByWorktree.
  const payload = session({
    unifiedTabs: {
      [ws]: [
        tab({ id: otherTabId, entityId: otherChat, lastFocusedAt: 9_999_999_999_999 }),
        tab({ lastFocusedAt: 1 })
      ]
    }
  })
  assert.deepEqual(selectFocusedChatTab(payload, ws), { id: chat, agent: 'claude', tabId })
  assert.deepEqual(selectFocusedChatTab(payload, `worktree:${ws}`), { id: chat, agent: 'claude', tabId })
})

test('requires the exact active workspace on the local host', () => {
  assert.equal(selectFocusedChatTab(session(), otherWs), null)
  assert.equal(selectFocusedChatTab(session({ activeWorkspaceExecutionHostId: 'ssh:box' }), ws), null)
  assert.equal(selectFocusedChatTab(session({ activeWorkspaceKey: undefined }), ws), null)
  assert.equal(selectFocusedChatTab(session({ activeWorkspaceKey: `worktree:${otherWs}` }), ws), null)
  // Mirrors Orca: an unset host is local; an unset key falls back to the exact worktree id.
  assert.deepEqual(selectFocusedChatTab(session({ activeWorkspaceExecutionHostId: undefined }), ws), { id: chat, agent: 'claude', tabId })
  assert.deepEqual(selectFocusedChatTab(session({ activeWorkspaceKey: undefined, activeWorktreeId: ws }), ws), { id: chat, agent: 'claude', tabId })
  assert.equal(selectFocusedChatTab(session({ activeWorkspaceKey: undefined, activeWorktreeId: otherWs }), ws), null)
})

test('rejects a non-chat active tab or an inconsistent active group', () => {
  assert.equal(selectFocusedChatTab(session({ activeTabTypeByWorktree: { [ws]: 'terminal' } }), ws), null)
  assert.equal(selectFocusedChatTab(session({ tabGroups: { [ws]: [{ id: 'group-1', activeTabId: otherTabId }] } }), ws), null)
  assert.equal(selectFocusedChatTab(session({ tabGroups: { [ws]: [] } }), ws), null)
  assert.equal(selectFocusedChatTab(session({ activeTabId: otherTabId }), ws), null)
  assert.equal(selectFocusedChatTab(session({ activeTabId: undefined }), ws), null)
})

test('rejects terminal, remote, unknown and legacy agent-session tabs', () => {
  const current = (row: Partial<Tab>) => session({
    unifiedTabs: { [ws]: [tab(row)] }
  })
  assert.equal(selectFocusedChatTab(current({ contentType: 'terminal' }), ws), null)
  assert.equal(selectFocusedChatTab(current({ executionHostId: 'ssh:box' }), ws), null)
  assert.equal(selectFocusedChatTab(current({ agentSessionAgent: undefined }), ws), null)
  assert.equal(selectFocusedChatTab(current({ entityId: legacyChat, id: legacyTabId }), ws), null)
  assert.deepEqual(selectFocusedChatTab(current({ entityId: undefined, id: tabId }), ws), { id: chat, agent: 'claude', tabId })
})

const deps = (file: string, overrides: Partial<FocusDeps> = {}): FocusDeps => ({
  stateFile: file,
  listChats: async () => chats,
  ...overrides
})

test('returns only a Chat that Orca still lists for the exact workspace', async () => {
  const { dir, file } = await createState(session())
  try {
    assert.equal(await discoverFocusedChat(ws, deps(file)), chat)
    assert.equal(await discoverFocusedChat(`worktree:${ws}`, deps(file)), chat)
    assert.equal(await discoverFocusedChat(ws, deps(file, { listChats: async () => [] })), null)
    assert.equal(await discoverFocusedChat(ws, deps(file, { listChats: async () => [{ id: chat, agent: 'antigravity' }] })), null)
    assert.equal(await discoverFocusedChat(ws, deps(file, { listChats: async () => { throw new Error('cli failed') } })), null)
    assert.equal(await discoverFocusedChat(otherWs, deps(file)), null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('passes the exact workspace key to the injected chat lister', async () => {
  const { dir, file } = await createState(session())
  try {
    let seen = ''
    assert.equal(await discoverFocusedChat(`worktree:${ws}`, deps(file, {
      listChats: async (id) => { seen = id; return chats }
    })), chat)
    assert.equal(seen, ws)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('locates profile-state.db through the Orca CLI when no path is given', async () => {
  const { dir, file } = await createState(session())
  try {
    const calls: readonly string[][] = []
    const result = await discoverFocusedChat(ws, {
      runCli: async (args) => {
        ;(calls as string[][]).push([...args])
        return JSON.stringify({ ok: true, result: { databaseFile: file } })
      },
      listChats: async () => chats
    })
    assert.equal(result, chat)
    assert.deepEqual(calls, [['profile', 'state', 'exports', '--json']])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('treats unavailable CLI/state and missing documents as no focused Chat', async () => {
  const { dir, file } = await createState(session())
  const empty = await mkdtemp(join(tmpdir(), 'chat-gauge-focus-empty-'))
  try {
    assert.equal(await discoverFocusedChat(ws, {
      runCli: async () => JSON.stringify({ ok: false, error: {} }),
      listChats: async () => chats
    }), null)
    assert.equal(await discoverFocusedChat(ws, {
      runCli: async () => 'not json',
      listChats: async () => chats
    }), null)
    assert.equal(await discoverFocusedChat(ws, {
      runCli: async () => { throw new Error('no cli') },
      listChats: async () => chats
    }), null)

    const missing = join(dir, 'missing.db')
    assert.equal(await discoverFocusedChat(ws, deps(missing)), null)
    assert.equal(await discoverFocusedChat(ws, deps(empty)), null)

    const broken = await mkdtemp(join(tmpdir(), 'chat-gauge-focus-broken-'))
    try {
      const brokenFile = join(broken, 'profile-state.db')
      const db = new DatabaseSync(brokenFile)
      try {
        db.exec('CREATE TABLE profile_state_documents (domain TEXT PRIMARY KEY, payload TEXT NOT NULL)')
        db.prepare('INSERT INTO profile_state_documents VALUES (?, ?)').run('workspaceSession', '{bad json')
      } finally { db.close() }
      assert.equal(await discoverFocusedChat(ws, deps(brokenFile)), null)
    } finally { await rm(broken, { recursive: true, force: true }) }
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(empty, { recursive: true, force: true })
  }
})

test('requires a state source and a chat lister', async () => {
  let threw = false
  try { await discoverFocusedChat(ws, { listChats: async () => chats }) } catch { threw = true }
  assert.equal(threw, true)
  threw = false
  try { await discoverFocusedChat(ws, {} as never) } catch { threw = true }
  assert.equal(threw, true)
})
