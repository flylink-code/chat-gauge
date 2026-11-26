import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assert, test } from 'orca/testing'
import {
  confirmNativeChatFocus,
  discoverFocusedChat,
  observeNativeChatFocus,
  selectFocusedChatTab,
  type FocusDeps,
  type NativeChatFocus
} from './chat-focus'

const ws = 'folder:11111111-1111-1111-1111-111111111111'
const otherWs = 'folder:33333333-3333-3333-3333-333333333333'
const chat = '22222222-2222-2222-2222-222222222222'
const otherChat = '44444444-4444-4444-4444-444444444444'
const worktree = '55555555-5555-5555-5555-555555555555::E:/repo/worktree'
const instanceId = '66666666-6666-6666-6666-666666666666'
const identity = `wt2:local:${instanceId}`
const remoteHost = 'runtime:77777777-7777-7777-7777-777777777777'
const tabId = `structured-agent-session-${chat}`
const otherTabId = `structured-agent-session-${otherChat}`
const legacyChat = 'claude_48975af4_8a54_4674_bb40_742b0950bdae'
const legacyTabId = `structured-agent-session-${legacyChat}`

type Tab = {
  id: string
  entityId?: string
  groupId?: string
  worktreeId?: string
  contentType?: string
  executionHostId?: string
  agentSessionAgent?: string
  lastFocusedAt?: number
}

const tab = (overrides: Partial<Tab> = {}): Tab => ({
  id: tabId,
  entityId: chat,
  groupId: 'group-1',
  worktreeId: ws,
  contentType: 'agent-session',
  executionHostId: 'local',
  agentSessionAgent: 'claude',
  lastFocusedAt: 1,
  ...overrides
})

const group = (overrides: Record<string, unknown> = {}) => ({
  id: 'group-1',
  worktreeId: ws,
  activeTabId: tabId,
  tabOrder: [tabId, otherTabId],
  ...overrides
})

const session = (overrides: Record<string, unknown> = {}) => ({
  activeWorkspaceExecutionHostId: 'local',
  activeWorkspaceKey: ws,
  activeWorktreeId: ws,
  // Orca's top-level activeTabId is the terminal surface, null while a Chat is in front.
  activeTabId: null,
  activeTabTypeByWorktree: { [ws]: 'agent-session', [otherWs]: 'terminal' },
  activeGroupIdByWorktree: { [ws]: 'group-1' },
  tabGroups: { [ws]: [group()] },
  // Also a terminal-surface id, never the unified active tab.
  activeTabIdByWorktree: { [ws]: 'terminal-surface-tab' },
  unifiedTabs: {
    [ws]: [tab(), tab({ id: otherTabId, entityId: otherChat })],
    [otherWs]: [tab({ id: otherTabId, entityId: otherChat, worktreeId: otherWs })]
  },
  ...overrides
})

const worktreeSession = (overrides: Record<string, unknown> = {}) =>
  session({
    activeWorkspaceKey: `worktree:${worktree}`,
    activeWorktreeId: worktree,
    activeTabTypeByWorktree: { [worktree]: 'agent-session' },
    activeGroupIdByWorktree: { [worktree]: 'group-1' },
    tabGroups: { [worktree]: [group({ worktreeId: worktree })] },
    activeTabIdByWorktree: { [worktree]: 'terminal-surface-tab' },
    unifiedTabs: { [worktree]: [tab({ worktreeId: worktree })] },
    ...overrides
  })

const focusedSession = (key: string, id: string, agent: string) => {
  const rawKey = key.startsWith('worktree:') ? key.slice('worktree:'.length) : key
  return {
    activeWorkspaceExecutionHostId: 'local',
    activeWorkspaceKey: rawKey.startsWith('folder:') ? rawKey : `worktree:${rawKey}`,
    activeWorktreeId: rawKey,
    activeTabId: null,
    activeTabTypeByWorktree: { [rawKey]: 'agent-session' },
    activeGroupIdByWorktree: { [rawKey]: 'group-1' },
    tabGroups: {
      [rawKey]: [{ id: 'group-1', worktreeId: rawKey, activeTabId: `structured-agent-session-${id}` }]
    },
    unifiedTabs: {
      [rawKey]: [
        {
          id: `structured-agent-session-${id}`,
          entityId: id,
          groupId: 'group-1',
          worktreeId: rawKey,
          contentType: 'agent-session',
          executionHostId: 'local',
          agentSessionAgent: agent
        }
      ]
    }
  }
}

type Document = { domain: string; payload: unknown; revision?: number; updatedAt?: number }

const createState = async (documents: Document[]) => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-focus-'))
  const file = join(dir, 'profile-state.db')
  const db = new DatabaseSync(file)
  try {
    db.exec(`CREATE TABLE profile_state_documents (
      domain TEXT PRIMARY KEY NOT NULL,
      payload TEXT NOT NULL,
      domain_version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      content_hash TEXT NOT NULL
    )`)
    const insert = db.prepare(
      'INSERT INTO profile_state_documents (domain, payload, domain_version, revision, updated_at, content_hash) VALUES (?, ?, ?, ?, ?, ?)'
    )
    documents.forEach((doc, index) =>
      insert.run(doc.domain, JSON.stringify(doc.payload), 1, doc.revision ?? index + 1, doc.updatedAt ?? 100 + index, '')
    )
  } finally {
    db.close()
  }
  return { dir, file }
}

const writeDocument = async (file: string, doc: Document, revision: number, updatedAt: number) => {
  const db = new DatabaseSync(file)
  try {
    db.prepare(
      'INSERT OR REPLACE INTO profile_state_documents (domain, payload, domain_version, revision, updated_at, content_hash) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(doc.domain, JSON.stringify(doc.payload), 1, revision, updatedAt, '')
  } finally {
    db.close()
  }
}

const chats = [{ id: chat, agent: 'claude' }]

const deps = (file: string, overrides: Partial<FocusDeps> = {}): FocusDeps => ({
  stateFile: file,
  listChats: async () => chats,
  ...overrides
})

test('selects the canonical active group tab, never terminal-surface or recency state', () => {
  const payload = session({
    activeTabId: otherTabId,
    activeTabIdByWorktree: { [ws]: otherTabId },
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

test('requires the exact active workspace and a valid local host', () => {
  assert.equal(selectFocusedChatTab(session(), otherWs), null)
  assert.equal(selectFocusedChatTab(session({ activeWorkspaceExecutionHostId: 'ssh:box' }), ws), null)
  assert.equal(selectFocusedChatTab(session({ activeWorkspaceExecutionHostId: 'garbage' }), ws), null)
  assert.equal(
    selectFocusedChatTab(session({ activeWorkspaceKey: undefined, activeWorktreeId: undefined }), ws),
    null
  )
  assert.equal(selectFocusedChatTab(session({ activeWorkspaceKey: `worktree:${otherWs}` }), ws), null)
  // Missing host is local; a missing scoped key falls back to the exact worktree id.
  assert.deepEqual(selectFocusedChatTab(session({ activeWorkspaceExecutionHostId: undefined }), ws), {
    id: chat,
    agent: 'claude',
    tabId
  })
  assert.deepEqual(selectFocusedChatTab(session({ activeWorkspaceKey: undefined, activeWorktreeId: ws }), ws), {
    id: chat,
    agent: 'claude',
    tabId
  })
  assert.equal(selectFocusedChatTab(session({ activeWorkspaceKey: undefined, activeWorktreeId: otherWs }), ws), null)
})

test('uses the recorded active group, falling back only when it is absent', () => {
  assert.equal(selectFocusedChatTab(session({ activeGroupIdByWorktree: { [ws]: 'missing' } }), ws), null)
  assert.equal(selectFocusedChatTab(session({ tabGroups: { [ws]: [] } }), ws), null)
  assert.equal(
    selectFocusedChatTab(
      session({ tabGroups: { [ws]: [group({ activeTabId: null })] } }),
      ws
    ),
    null
  )
  assert.deepEqual(selectFocusedChatTab(session({ activeGroupIdByWorktree: {} }), ws), {
    id: chat,
    agent: 'claude',
    tabId
  })
  // The group's tab must actually belong to that group.
  assert.equal(
    selectFocusedChatTab(
      session({
        tabGroups: { [ws]: [group()] },
        unifiedTabs: { [ws]: [tab({ groupId: 'other-group' })] }
      }),
      ws
    ),
    null
  )
})

test('rejects non-chat, remote, unknown and legacy tabs', () => {
  const current = (row: Partial<Tab>) =>
    session({
      activeGroupIdByWorktree: { [ws]: 'group-1' },
      tabGroups: { [ws]: [group({ activeTabId: row.id ?? tabId })] },
      unifiedTabs: { [ws]: [tab(row)] }
    })
  assert.equal(selectFocusedChatTab(current({ contentType: 'terminal', executionHostId: undefined, agentSessionAgent: undefined }), ws), null)
  assert.equal(selectFocusedChatTab(current({ executionHostId: 'ssh:box' }), ws), null)
  assert.equal(selectFocusedChatTab(current({ agentSessionAgent: undefined }), ws), null)
  assert.equal(selectFocusedChatTab(current({ entityId: legacyChat, id: legacyTabId }), ws), null)
  assert.equal(selectFocusedChatTab(current({ entityId: otherChat }), ws), null)
  assert.deepEqual(selectFocusedChatTab(current({ entityId: undefined, id: tabId }), ws), {
    id: chat,
    agent: 'claude',
    tabId
  })
})

test('observes the focused Chat without a roster lookup', async () => {
  const { dir, file } = await createState([{ domain: 'workspaceSession', payload: session() }])
  try {
    assert.deepEqual(await observeNativeChatFocus({ stateFile: file }), {
      workspaceId: ws,
      id: chat,
      agent: 'claude'
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('returns null from observation when the active tab is not a native Chat', async () => {
  const terminalTab = tab({ id: 'terminal-tab', entityId: 'terminal-tab', contentType: 'terminal', agentSessionAgent: undefined })
  const payload = session({
    activeGroupIdByWorktree: { [ws]: 'group-1' },
    tabGroups: { [ws]: [group({ activeTabId: 'terminal-tab' })] },
    unifiedTabs: { [ws]: [terminalTab] }
  })
  const { dir, file } = await createState([{ domain: 'workspaceSession', payload }])
  try {
    assert.equal(await observeNativeChatFocus({ stateFile: file }), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('exposes identity: selectors and re-checks them against the live roster', async () => {
  const { dir, file } = await createState([
    { domain: 'workspaceSession', payload: worktreeSession() },
    { domain: 'worktreeMeta', payload: { [worktree]: { instanceId, hostId: 'local' } } },
    {
      domain: 'worktreeIdentityAliases',
      payload: { [`local|${worktree}`]: [identity] }
    }
  ])
  try {
    const observed = await observeNativeChatFocus({ stateFile: file })
    assert.deepEqual(observed, { workspaceId: `identity:${identity}`, id: chat, agent: 'claude' })

    const selectors: string[] = []
    const listChats: FocusDeps['listChats'] = async (id) => {
      selectors.push(id)
      return chats
    }
    // raw id, identity and id: forms all resolve to the same observation.
    assert.equal(await discoverFocusedChat(worktree, deps(file, { listChats })), chat)
    assert.equal(await discoverFocusedChat(`identity:${identity}`, deps(file, { listChats })), chat)
    assert.equal(await discoverFocusedChat(`id:${worktree}`, deps(file, { listChats })), chat)
    assert.deepEqual(selectors, [`identity:${identity}`, `identity:${identity}`, `identity:${identity}`])

    // The live roster is the independent check: an alias match with no live
    // Chat for that exact workspace is not a focus.
    assert.equal(
      await discoverFocusedChat(worktree, deps(file, { listChats: async () => [] })),
      null
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('resolves identity from aliases when worktreeMeta has no row', async () => {
  const { dir, file } = await createState([
    { domain: 'workspaceSession', payload: worktreeSession() },
    { domain: 'worktreeMeta', payload: {} },
    { domain: 'worktreeIdentityAliases', payload: { [`local|${worktree}`]: [identity] } }
  ])
  try {
    assert.deepEqual(await observeNativeChatFocus({ stateFile: file }), {
      workspaceId: `identity:${identity}`,
      id: chat,
      agent: 'claude'
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('never emits or accepts a foreign identity for a local workspace', async () => {
  const foreignIdentity = `wt2:${encodeURIComponent(remoteHost)}:${instanceId}`
  const { dir, file } = await createState([
    { domain: 'workspaceSession', payload: worktreeSession() },
    { domain: 'worktreeMeta', payload: { [worktree]: { instanceId, hostId: remoteHost } } },
    { domain: 'worktreeIdentityAliases', payload: { [`${remoteHost}|${worktree}`]: [foreignIdentity] } }
  ])
  try {
    assert.deepEqual(await observeNativeChatFocus({ stateFile: file }), {
      workspaceId: worktree,
      id: chat,
      agent: 'claude'
    })
    assert.equal(await discoverFocusedChat(`identity:${foreignIdentity}`, deps(file)), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('does not guess when one worktree has several identity aliases', async () => {
  const second = `wt2:local:88888888-8888-8888-8888-888888888888`
  const { dir, file } = await createState([
    { domain: 'workspaceSession', payload: worktreeSession() },
    { domain: 'worktreeMeta', payload: {} },
    { domain: 'worktreeIdentityAliases', payload: { [`local|${worktree}`]: [identity, second] } }
  ])
  try {
    assert.deepEqual(await observeNativeChatFocus({ stateFile: file }), {
      workspaceId: worktree,
      id: chat,
      agent: 'claude'
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rejects a foreign active host before any match or roster lookup', async () => {
  // The partition holds a plausible local Chat; a foreign active pointer must
  // not make it eligible, and discovery must not touch the roster.
  const partition = focusedSession(worktree, chat, 'claude')
  const remoteSession = {
    ...focusedSession(worktree, otherChat, 'antigravity'),
    activeWorkspaceExecutionHostId: remoteHost
  }
  const { dir, file } = await createState([
    { domain: 'workspaceSession', payload: remoteSession },
    { domain: 'workspaceSessionsByHostId', payload: { [remoteHost]: partition } },
    { domain: 'worktreeMeta', payload: { [worktree]: { instanceId, hostId: remoteHost } } }
  ])
  try {
    assert.equal(await observeNativeChatFocus({ stateFile: file }), null)
    let rosterCalled = false
    assert.equal(
      await discoverFocusedChat(worktree, deps(file, {
        listChats: async () => {
          rosterCalled = true
          return chats
        }
      })),
      null
    )
    assert.equal(rosterCalled, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a host partition never overrides the local session focus', async () => {
  const partition = focusedSession(ws, otherChat, 'antigravity')
  const { dir, file } = await createState([
    { domain: 'workspaceSession', payload: session() },
    { domain: 'workspaceSessionsByHostId', payload: { [remoteHost]: partition } }
  ])
  try {
    assert.deepEqual(await observeNativeChatFocus({ stateFile: file }), {
      workspaceId: ws,
      id: chat,
      agent: 'claude'
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cache follows the document revision instead of hiding a newer focus', async () => {
  const { dir, file } = await createState([
    { domain: 'workspaceSession', payload: session(), revision: 1, updatedAt: 100 }
  ])
  try {
    assert.equal((await observeNativeChatFocus({ stateFile: file }))?.id, chat)
    await writeDocument(
      file,
      { domain: 'workspaceSession', payload: focusedSession(otherWs, otherChat, 'antigravity') },
      2,
      101
    )
    assert.deepEqual(await observeNativeChatFocus({ stateFile: file }), {
      workspaceId: otherWs,
      id: otherChat,
      agent: 'antigravity'
    })
    // Same revision but a new write timestamp must also reparse.
    await writeDocument(
      file,
      { domain: 'workspaceSession', payload: focusedSession(ws, chat, 'claude') },
      2,
      102
    )
    assert.equal((await observeNativeChatFocus({ stateFile: file }))?.id, chat)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cache also follows identity document revisions', async () => {
  const { dir, file } = await createState([
    { domain: 'workspaceSession', payload: worktreeSession(), revision: 1, updatedAt: 100 },
    { domain: 'worktreeMeta', payload: { [worktree]: { instanceId, hostId: 'local' } }, revision: 2, updatedAt: 101 },
    { domain: 'worktreeIdentityAliases', payload: {}, revision: 3, updatedAt: 102 }
  ])
  try {
    assert.equal((await observeNativeChatFocus({ stateFile: file }))?.workspaceId, `identity:${identity}`)
    // The session did not change, but removing the identity must re-derive it.
    await writeDocument(file, { domain: 'worktreeMeta', payload: {} }, 4, 103)
    assert.equal((await observeNativeChatFocus({ stateFile: file }))?.workspaceId, worktree)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('returns only a Chat that Orca still lists for the exact workspace', async () => {
  const { dir, file } = await createState([{ domain: 'workspaceSession', payload: session() }])
  try {
    assert.equal(await discoverFocusedChat(ws, deps(file)), chat)
    assert.equal(await discoverFocusedChat(`worktree:${ws}`, deps(file)), chat)
    assert.equal(await discoverFocusedChat(ws, deps(file, { listChats: async () => [] })), null)
    assert.equal(
      await discoverFocusedChat(ws, deps(file, { listChats: async () => [{ id: chat, agent: 'antigravity' }] })),
      null
    )
    assert.equal(
      await discoverFocusedChat(ws, deps(file, { listChats: async () => { throw new Error('cli failed') } })),
      null
    )
    assert.equal(await discoverFocusedChat(otherWs, deps(file)), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('passes the exact workspace key to the injected chat lister', async () => {
  const { dir, file } = await createState([{ domain: 'workspaceSession', payload: session() }])
  try {
    let seen = ''
    assert.equal(
      await discoverFocusedChat(`worktree:${ws}`, deps(file, {
        listChats: async (id) => {
          seen = id
          return chats
        }
      })),
      chat
    )
    assert.equal(seen, ws)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('confirms an observation against the exact roster', async () => {
  const focus: NativeChatFocus = { workspaceId: ws, id: chat, agent: 'claude' }
  const seen: string[] = []
  assert.equal(
    await confirmNativeChatFocus(focus, async (id) => {
      seen.push(id)
      return chats
    }),
    chat
  )
  assert.deepEqual(seen, [ws])
  assert.equal(await confirmNativeChatFocus(focus, async () => []), null)
  assert.equal(await confirmNativeChatFocus({ ...focus, agent: 'codex' }, async () => chats), null)
  assert.equal(await confirmNativeChatFocus({ ...focus, id: 'not-a-uuid' }, async () => chats), null)
  assert.equal(await confirmNativeChatFocus({ ...focus, agent: '' }, async () => chats), null)
})

test('locates profile-state.db through the Orca CLI when no path is given', async () => {
  const { dir, file } = await createState([{ domain: 'workspaceSession', payload: session() }])
  try {
    const calls: readonly string[][] = []
    const result = await observeNativeChatFocus({
      runCli: async (args) => {
        ;(calls as string[][]).push([...args])
        return JSON.stringify({ ok: true, result: { databaseFile: file } })
      }
    })
    assert.deepEqual(result, { workspaceId: ws, id: chat, agent: 'claude' })
    assert.deepEqual(calls, [['profile', 'state', 'exports', '--json']])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('treats unavailable CLI/state and missing documents as no focused Chat', async () => {
  const { dir, file } = await createState([{ domain: 'workspaceSession', payload: session() }])
  const empty = await mkdtemp(join(tmpdir(), 'chat-gauge-focus-empty-'))
  try {
    assert.equal(await observeNativeChatFocus({ runCli: async () => JSON.stringify({ ok: false, error: {} }) }), null)
    assert.equal(await observeNativeChatFocus({ runCli: async () => 'not json' }), null)
    assert.equal(await observeNativeChatFocus({ runCli: async () => { throw new Error('no cli') } }), null)

    const missing = join(dir, 'missing.db')
    assert.equal(await observeNativeChatFocus({ stateFile: missing }), null)
    assert.equal(await observeNativeChatFocus({ stateFile: empty }), null)

    const noDocuments = await createState([])
    try {
      assert.equal(await observeNativeChatFocus({ stateFile: noDocuments.file }), null)
    } finally {
      await rm(noDocuments.dir, { recursive: true, force: true })
    }

    const broken = await createState([])
    try {
      const db = new DatabaseSync(broken.file)
      try {
        db.prepare(
          'INSERT INTO profile_state_documents (domain, payload, domain_version, revision, updated_at, content_hash) VALUES (?, ?, ?, ?, ?, ?)'
        ).run('workspaceSession', '{bad json', 1, 1, 1, '')
      } finally {
        db.close()
      }
      assert.equal(await observeNativeChatFocus({ stateFile: broken.file }), null)
    } finally {
      await rm(broken.dir, { recursive: true, force: true })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(empty, { recursive: true, force: true })
  }
})

test('requires a state source and a chat lister', async () => {
  let threw = false
  try {
    await observeNativeChatFocus({} as never)
  } catch {
    threw = true
  }
  assert.equal(threw, true)

  threw = false
  try {
    await discoverFocusedChat(ws, { listChats: async () => chats })
  } catch {
    threw = true
  }
  assert.equal(threw, true)

  threw = false
  try {
    await discoverFocusedChat(ws, {} as never)
  } catch {
    threw = true
  }
  assert.equal(threw, true)
})
