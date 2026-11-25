import { execFile } from 'node:child_process'
import { lstat, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { Chat } from './protocol'
import { readNativeContext } from './context'
import { agentLabel } from './format'
import { isRecord } from './transcript'

const run = promisify(execFile)
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

const roaming = () => process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
export const nativeContext = (chatId: string) => readNativeContext(roaming(), chatId)

export async function listChats(workspaceId: string): Promise<Chat[]> {
  const env = { ...process.env }
  // Do not inherit a paired host, workspace selector, or Electron's worker launch mode.
  for (const key of Object.keys(env)) {
    if (/^ORCA_|^ELECTRON_RUN_AS_NODE$/i.test(key)) delete env[key]
  }
  const bundled = join(dirname(process.execPath), 'resources', 'bin', 'orca.exe')
  const installed = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'orca', 'resources', 'bin', 'orca.exe')
  // A daemon-host copy of Orca.exe does not include the packaged CLI.
  const cli = basename(process.execPath).toLowerCase() === 'orca.exe' &&
    (await lstat(bundled).catch(() => null))?.isFile() ? bundled : installed
  env.APPDATA = roaming()
  const { stdout } = await run(cli, ['agent', 'list', '--environment', 'local', `--worktree=${workspaceId}`, '--json'], {
    env, cwd: homedir(), windowsHide: true, timeout: 3500, maxBuffer: 2 * 1024 * 1024
  })
  const data: unknown = JSON.parse(stdout)
  if (!isRecord(data) || data.ok !== true || !isRecord(data.result) || !Array.isArray(data.result.agents) || data.result.truncated === true) {
    throw new Error('Orca did not return a complete chat list')
  }
  const chats = new Map<string, Chat>()
  for (const row of data.result.agents) {
    if (!isRecord(row) || row.hostId !== 'local' || row.kind !== 'chat' || typeof row.agent !== 'string' || !row.agent) continue
    const raw = row.orcaSessionId
    if (typeof raw !== 'string') continue
    const id = raw.replace(/^orca_session_id:/, '')
    if (!uuid.test(id)) continue
    const agent = row.agent.slice(0, 64)
    chats.set(id, { id, agent, title: typeof row.title === 'string' && row.title ? row.title.slice(0, 90) : `${agentLabel(agent)} Chat (${id.slice(0, 8)})`, state: typeof row.state === 'string' ? row.state : '' })
  }
  return [...chats.values()]
}

export function decodeSession(record: unknown): { id: string; config: string | null } | null {
  if (!isRecord(record) || record.schemaVersion !== 2 || record.provider !== 'claude' ||
      !isRecord(record.location) || record.location.executionHostId !== 'local' || record.location.wslDistro ||
      !Array.isArray(record.providerHandleChain)) return null
  const link: unknown = record.providerHandleChain.at(-1)
  const handle = isRecord(link) ? link.handle : null
  if (!isRecord(handle) || handle.provider !== 'claude' || typeof handle.sessionId !== 'string' || !uuid.test(handle.sessionId)) return null
  const home = record.accountHome
  const config = isRecord(home) && home.variable === 'CLAUDE_CONFIG_DIR' && typeof home.path === 'string' && isAbsolute(home.path) ? home.path : null
  return { id: handle.sessionId, config }
}

export async function resolveChat(chatId: string) {
  if (!uuid.test(chatId)) return null
  const { DatabaseSync } = await import('node:sqlite')
  // Orca's worker environment omits APPDATA; the default Windows install lives here.
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  const db = new DatabaseSync(join(appData, 'orca', 'agent-session-domain.db'), { readOnly: true })
  try {
    const row = db.prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?').get(chatId)
    return typeof row?.record_json === 'string' ? decodeSession(JSON.parse(row.record_json)) : null
  } finally { db.close() }
}

export async function findTranscript(session: { id: string; config: string | null }): Promise<string | null> {
  if (!uuid.test(session.id)) return null
  const roots = new Set([session.config, process.env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude')])
  // Prefer the account Orca identifies; only fall back to another home for the exact same UUID.
  for (const root of roots) {
    if (!root || !isAbsolute(root)) continue
    const projects = join(root, 'projects')
    const dirs = await readdir(projects, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return []
      throw e
    })
    const matches: string[] = []
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      const path = join(projects, dir.name, `${session.id}.jsonl`)
      const stat = await lstat(path).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null
        throw e
      })
      if (stat?.isFile()) matches.push(path)
      if (matches.length > 1) return null
    }
    if (matches.length === 1) return matches[0]
  }
  return null
}
