#!/usr/bin/env node
/**
 * Standalone rendering check for the Chat Gauge HTML panel.
 *
 * This script does NOT modify the plugin. It:
 *   1. serves the repository over a local HTTP server, transpiling .ts modules
 *      with the repo's own TypeScript (no bundler, no network),
 *   2. injects a mock Orca frame bridge (`window.orca`) before the panel module runs,
 *   3. drives Edge/Chrome headless over the DevTools protocol,
 *   4. renders the real `src/panel.html` at 260/320/400 px in light and dark,
 *      exercises chat switching and missing-metric states,
 *   5. asserts layout/theme/data/accessibility basics and writes PNGs to .orca/check/.
 *
 * Usage:
 *   node scripts/check-panel.mjs
 *   node scripts/check-panel.mjs --widths 260,320,400 --themes light,dark
 *   node scripts/check-panel.mjs --scenario detailed --json
 *   node scripts/check-panel.mjs --wait 180      # poll for the implementation
 *   node scripts/check-panel.mjs --panel .orca/check/fixture/panel.html
 *
 * Exit codes: 0 all checks pass, 1 a check failed, 3 panel implementation not present.
 */
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import { promises as fsp, existsSync, readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = path.join(ROOT, 'src')
const OUT_DIR = path.join(ROOT, '.orca', 'check')
const DEFAULT_PANEL = path.join(ROOT, 'src', 'panel.html')
const EXPECTED_MODULE = path.join(ROOT, 'src', 'html-panel.ts')
const T0 = 1760000000000

// ---------------------------------------------------------------------------
// Synthetic snapshots (same shape as src/protocol.ts).
// ---------------------------------------------------------------------------
const CHATS = {
  claude: { id: 'example', title: 'Local Claude Chat', state: 'working', agent: 'claude' },
  other: { id: 'other', title: 'Other chat', state: 'done', agent: 'pi' },
  agy: { id: 'agy', title: 'A long Antigravity conversation title to fit in a narrow sidebar', state: 'working', agent: 'antigravity' }
}
const DETAILED_CATEGORIES = [
  { name: 'Messages', tokens: 73000 },
  { name: 'System prompt', tokens: 10000 },
  { name: 'System tools', tokens: 9911 },
  { name: 'Memory files', tokens: 1000 },
  { name: 'Free space', tokens: 4000 },
  { name: 'Autocompact buffer', tokens: 2089 },
  { name: 'MCP tools', tokens: 12000, deferred: true }
]
const snap = (over) => ({
  phase: 'ready', locale: 'en', chats: [], selected: null,
  sample: null, context: null, windowTokens: null, ...over
})

const DETAILED = snap({
  chats: [CHATS.claude, CHATS.other, CHATS.agy],
  selected: 'example',
  windowTokens: 100000,
  sample: { model: 'gateway/example', inputTokens: 93591, outputTokens: 320, durationMs: 23000, completedAt: T0, cacheReadTokens: 90000 },
  context: {
    kind: 'report', usedTokens: 93911, windowTokens: 100000, model: 'gateway/example', capturedAt: T0,
    categories: DETAILED_CATEGORIES
  }
})
const SWITCH_OTHER = snap({
  chats: DETAILED.chats, selected: 'other', windowTokens: 200000,
  sample: { model: 'pi/other', inputTokens: 12000, outputTokens: 400, durationMs: 10000, completedAt: T0 + 60000 },
  context: null
})
const SWITCH_AGY = snap({
  chats: DETAILED.chats, selected: 'agy',
  context: { kind: 'estimate', usedTokens: 364588, windowTokens: 1048576, model: null, capturedAt: T0 },
  sample: null
})
const MISSING = snap({
  chats: [CHATS.agy], selected: 'agy',
  context: { kind: 'estimate', usedTokens: 364588, windowTokens: 1048576, model: null, capturedAt: T0 }
})
const NO_CONTEXT = snap({
  chats: [CHATS.claude], selected: 'example',
  sample: { model: 'gateway/example', inputTokens: 12000, outputTokens: 300, durationMs: 10000, completedAt: T0 }
})
const CHOOSE = snap({ phase: 'choose', chats: [CHATS.claude, CHATS.other, CHATS.agy], selected: null })
const EMPTY = snap({ phase: 'empty' })

const SCENARIOS = {
  detailed: { snapshot: DETAILED, byChat: { example: DETAILED, other: SWITCH_OTHER, agy: SWITCH_AGY } },
  missing: { snapshot: MISSING, byChat: { agy: MISSING } },
  'no-context': { snapshot: NO_CONTEXT, byChat: { example: NO_CONTEXT } },
  choose: { snapshot: CHOOSE, byChat: { example: DETAILED, other: SWITCH_OTHER, agy: SWITCH_AGY } },
  empty: { snapshot: EMPTY, byChat: {} }
}

// ---------------------------------------------------------------------------
// Mock frame bridge. Runs in the page before any panel module.
// ---------------------------------------------------------------------------
function harnessPrelude() {
  const cfg = window.__CHAT_GAUGE_CONFIG__ || {}
  const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)))
  const state = {
    startedAt: Date.now(),
    domReady: document.readyState !== 'loading',
    requests: [],
    inflight: 0,
    errors: [],
    logs: []
  }
  const handlers = new Map()
  let current = clone(cfg.initial || { phase: 'loading', locale: 'en', chats: [], selected: null, sample: null, context: null, windowTokens: null })

  // Theme: the real shell sets `light`/`dark` on <html>; OS fallback is prefers-color-scheme.
  const scheme = cfg.theme === 'auto' ? (cfg.osScheme || 'light') : (cfg.theme || 'light')
  const dark = scheme === 'dark'
  const nativeMatchMedia = window.matchMedia.bind(window)
  window.matchMedia = (query) => {
    const q = String(query)
    if (/prefers-color-scheme\s*:\s*dark/i.test(q)) {
      return { matches: dark, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false } }
    }
    if (/prefers-color-scheme\s*:\s*light/i.test(q)) {
      return { matches: !dark, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false } }
    }
    return nativeMatchMedia(query)
  }
  const root = document.documentElement
  const explicitTheme = cfg.theme === 'dark' || cfg.theme === 'light'
  if (explicitTheme) {
    root.classList.toggle('dark', dark)
    root.classList.toggle('light', !dark)
    root.style.colorScheme = dark ? 'dark' : 'light'
  } else {
    // Auto: the shell leaves the theme classes off and the OS prefers-color-scheme decides.
    root.classList.remove('dark', 'light')
    root.style.colorScheme = 'light dark'
  }

  const err = (e) => state.errors.push(e && e.stack ? String(e.stack) : String((e && e.message) || e))
  window.addEventListener('error', (e) => err(e.error || e.message))
  window.addEventListener('unhandledrejection', (e) => err(e.reason))
  const nativeConsoleError = console.error.bind(console)
  console.error = (...args) => { state.logs.push(args.map(String).join(' ')); nativeConsoleError(...args) }

  const emit = (event, payload) => {
    for (const handler of handlers.get(event) || []) {
      try { handler(clone(payload)) } catch (e) { err(e) }
    }
  }
  const on = (event, handler) => {
    if (!handlers.has(event)) handlers.set(event, new Set())
    handlers.get(event).add(handler)
    return { dispose() { handlers.get(event)?.delete(handler) } }
  }

  const respond = (name, input) => {
    if (name === 'gauge.get') return { ok: true, value: clone(current) }
    if (name === 'gauge.select') {
      const id = input && input.id
      const next = cfg.byChat && cfg.byChat[id]
      if (!next) return { ok: false, code: 'invalid_params', message: 'unknown chat: ' + String(id) }
      current = clone(next)
      return { ok: true, value: clone(current) }
    }
    return { ok: false, code: 'unknown_method', message: 'unknown method: ' + String(name) }
  }

  const plugin = {
    request(name, input) {
      state.requests.push({ name, input, at: Date.now() - state.startedAt })
      state.inflight++
      const result = respond(name, input)
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          state.inflight--
          if (!result.ok) {
            const e = new Error(result.message)
            e.code = result.code
            reject(e)
            return
          }
          resolve(clone(result.value))
          // A real worker also posts the change; panels may use either path.
          if (name === 'gauge.select') setTimeout(() => emit('gauge.changed', current), 5)
        }, 8)
      })
    },
    on(event, handler) {
      if (event === 'gauge.changed') return on('gauge.changed', handler)
      return on(event, handler)
    }
  }

  const emptySettings = { language: 'auto', contextWindowTokens: 0 }
  const orca = {
    api: { major: 1, minor: 10 },
    locale: cfg.locale || 'en-US',
    env: { locale: cfg.locale || 'en-US', theme: { colorScheme: dark ? 'dark' : 'light' }, client: 'desktop' },
    plugin,
    on,
    host: {
      async call(method, params) {
        state.requests.push({ name: 'host.' + method, input: params, at: Date.now() - state.startedAt })
        if (method === 'settings.get') return { settings: { ...emptySettings } }
        if (method === 'storage.get') return { value: null }
        return {}
      },
      has() { return true }
    },
    storage: {
      async get() { return null }, async set() {}, async delete() {}, async keys() { return [] },
      onDidChange() { return { dispose() {} } }
    },
    settings: {
      async get(key) { return key ? emptySettings[key] : { ...emptySettings } },
      async set() {},
      onDidChange() { return { dispose() {} } }
    },
    secrets: { async get() { return null }, async set() {}, async delete() {} }
  }
  window.orca = orca
  globalThis.orca = orca

  window.__harness = {
    get state() { return state },
    snapshot() { return clone(current) },
    emit,
    emitTheme(colorScheme) {
      root.classList.toggle('dark', colorScheme === 'dark')
      root.classList.toggle('light', colorScheme !== 'dark')
      root.style.colorScheme = colorScheme
      emit('theme', { colorScheme })
    },
    setSnapshot(next) { current = clone(next); emit('gauge.changed', current) }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { state.domReady = true }, { once: true })
  } else {
    state.domReady = true
  }
}

const PRELUDE_JS = `;(${harnessPrelude.toString()})();`

// ---------------------------------------------------------------------------
// TypeScript transpilation + import rewriting (browser can load .ts URLs).
// ---------------------------------------------------------------------------
function isFile(p) {
  try { return existsSync(p) && require('node:fs').statSync(p).isFile() } catch { return false }
}

function resolveSpecifier(spec, fromFile) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return spec
  const base = spec.startsWith('/') ? path.join(ROOT, spec) : path.resolve(path.dirname(fromFile), spec)
  const candidates = [base, base + '.ts', base + '.tsx', base + '.js', base + '.mjs', path.join(base, 'index.ts'), path.join(base, 'index.js')]
  for (const candidate of candidates) {
    if (isFile(candidate)) return '/' + path.relative(ROOT, candidate).replaceAll('\\', '/')
  }
  return spec
}

function rewriteImports(js, fromFile) {
  return js
    .replace(/(\bfrom\s*)(['"])([^'"]+)\2/g, (m, pre, q, spec) => pre + q + resolveSpecifier(spec, fromFile) + q)
    .replace(/(\bimport\s*\(\s*)(['"])([^'"]+)\2(\s*\))/g, (m, pre, q, spec, post) => pre + q + resolveSpecifier(spec, fromFile) + q + post)
    .replace(/(\bimport\s*)(['"])([^'"]+)\2/g, (m, pre, q, spec) => pre + q + resolveSpecifier(spec, fromFile) + q)
}

function transpile(source, filename) {
  const out = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
      sourceMap: false,
      inlineSourceMap: false,
      removeComments: false
    }
  })
  return rewriteImports(out.outputText, filename)
}

// ---------------------------------------------------------------------------
// Local HTTP server.
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8', '.tsx': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
}

function htmlConfig(url, panelPath) {
  const scenarioName = url.searchParams.get('scenario') || 'detailed'
  const scenario = SCENARIOS[scenarioName] || SCENARIOS.detailed
  return {
    theme: url.searchParams.get('theme') || 'light',
    osScheme: url.searchParams.get('os') || 'light',
    locale: url.searchParams.get('locale') || 'en-US',
    scenario: scenarioName,
    initial: scenario.snapshot,
    byChat: scenario.byChat,
    panel: '/' + path.relative(ROOT, panelPath).replaceAll('\\', '/')
  }
}

function injectHarness(html, config) {
  const json = JSON.stringify(config).replaceAll('<', '\\u003c')
  const head = [
    `<script>window.__CHAT_GAUGE_CONFIG__=${json};</script>`,
    '<script src="/__harness/prelude.js"></script>'
  ]
  // Only add an import map when the panel has none, so a real panel's map wins.
  if (!/<script[^>]+type\s*=\s*["']importmap["']/i.test(html)) {
    head.push('<script type="importmap">' + JSON.stringify({
      imports: {
        'orca': '/__harness/orca-stub.js',
        'orca/frame': '/__harness/orca-stub.js',
        'orca/host': '/__harness/orca-stub.js',
        'orca/jsx-runtime': '/__harness/orca-stub.js'
      }
    }) + '</script>')
  }
  const bundle = head.join('\n')
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + '\n' + bundle)
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (m) => m + '\n' + bundle)
  return bundle + '\n' + html
}

const ALLOWED_EXT = new Set(['.html', '.css', '.ts', '.tsx', '.js', '.mjs', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.ttf', '.ico'])

function startServer(panelPath) {
  const panelDir = path.dirname(panelPath)
  // Only the panel sources, the fixture, and the panel's own directory. Never the repo root,
  // .git, node_modules, screenshots or report files.
  const allowedRoots = [SRC_DIR, path.join(OUT_DIR, 'fixture'), panelDir === ROOT ? panelPath : panelDir]
  const allowed = (file) => allowedRoots.some((root) => file !== root && file.startsWith(root + path.sep)) && ALLOWED_EXT.has(path.extname(file).toLowerCase())
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1')
        let pathname = decodeURIComponent(url.pathname)
        if (pathname === '/__harness/prelude.js') return send(res, PRELUDE_JS, MIME['.js'])
        if (pathname === '/__harness/orca-stub.js') return send(res, 'export default {};\n', MIME['.js'])
        if (pathname === '/') pathname = '/' + path.relative(ROOT, panelPath).replaceAll('\\', '/')

        const file = path.resolve(ROOT, '.' + pathname)
        if ((!file.startsWith(ROOT + path.sep) && file !== ROOT) || !allowed(file)) return send(res, 'forbidden', 'text/plain', 403)
        const data = await fsp.readFile(file)
        const ext = path.extname(file).toLowerCase()
        if (ext === '.ts' || ext === '.tsx') {
          return send(res, transpile(data.toString('utf8'), file), MIME['.js'])
        }
        if (ext === '.html') {
          const html = data.toString('utf8')
          const inject = file === panelPath
          return send(res, inject ? injectHarness(html, htmlConfig(url, panelPath)) : html, MIME['.html'])
        }
        return send(res, data, MIME[ext] || 'application/octet-stream')
      } catch (e) {
        if (e && e.code !== 'ENOENT') console.error('[server]', e.message)
        return send(res, 'not found: ' + req.url, 'text/plain', 404)
      }
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: address.port, address: address.address })
    })
  })
}

function send(res, body, type, status = 200) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(body)
}

/** Refuse to start the browser unless the static server is loopback-only and locked down. */
async function verifyServerLockdown(port, panelUrlPath) {
  const base = `http://127.0.0.1:${port}`
  const expected = [
    [panelUrlPath, 200], ['/__harness/prelude.js', 200],
    ['/package.json', 403], ['/.git/config', 403], ['/README.md', 403], ['/.orca/check/report.json', 403]
  ]
  for (const [pathname, status] of expected) {
    const res = await fetch(base + pathname, { signal: AbortSignal.timeout(3000) })
    if (res.status !== status) throw new Error(`static server lockdown failed: ${pathname} -> ${res.status}, expected ${status}`)
  }
}

// ---------------------------------------------------------------------------
// Edge headless + minimal CDP client.
// ---------------------------------------------------------------------------
function findBrowser() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ].filter(Boolean)
  for (const candidate of candidates) if (isFile(candidate)) return candidate
  return null
}

async function freePort() {
  const net = require('node:net')
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })
}

async function waitFor(fn, timeoutMs, intervalMs, label) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn()
      if (value) return value
    } catch (e) { lastError = e }
    await delay(intervalMs)
  }
  const suffix = lastError ? ` (last error: ${lastError.message})` : ''
  throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms${suffix}`)
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.handlers = new Map()
    this.events = []
    ws.addEventListener('message', (event) => {
      let msg
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) } catch { return }
      if (msg.id) {
        const pending = this.pending.get(msg.id)
        if (!pending) return
        this.pending.delete(msg.id)
        if (msg.error) pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
        else pending.resolve(msg.result)
        return
      }
      this.events.push(msg)
      for (const fn of this.handlers.get(msg.method) || []) fn(msg.params)
    })
  }
  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) }
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set())
    this.handlers.get(method).add(fn)
    return () => this.handlers.get(method)?.delete(fn)
  }
  close() { try { this.ws.close() } catch {} }
}

async function launchBrowser(browserPath) {
  const port = await freePort()
  const profile = path.join(OUT_DIR, `edge-profile-${process.pid}-${Date.now()}`)
  mkdirSync(profile, { recursive: true })
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    '--safebrowsing-disable-auto-update',
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    'about:blank'
  ]
  const child = spawn(browserPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let stderr = ''
  let spawnError = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  child.on('error', (e) => { spawnError = e.message })
  const endpoint = `http://127.0.0.1:${port}`
  try {
    // Edge's launcher process may exit 0 while the real browser process keeps running, so the
    // DevTools endpoint (not the child's exit code) decides whether the browser is up.
    await waitFor(async () => {
      const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })
      return res.ok
    }, 20000, 200, 'browser DevTools endpoint')
  } catch (e) {
    const reason = spawnError || `exit ${child.exitCode}: ${stderr.slice(-800) || '(no stderr)'}`
    try { child.kill() } catch {}
    throw new Error(`${e.message}; ${reason}`)
  }
  return { child, port, profile, endpoint }
}

async function closeBrowser(browser) {
  // Ask the browser process itself to close (the launcher PID may already be gone on Edge).
  try {
    const version = await (await fetch(`${browser.endpoint}/json/version`, { signal: AbortSignal.timeout(1500) })).json()
    if (version.webSocketDebuggerUrl) {
      const ws = new WebSocket(version.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true })
        ws.addEventListener('error', reject, { once: true })
        setTimeout(reject, 2000)
      })
      ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
      await delay(400)
      try { ws.close() } catch {}
    }
  } catch {}
  try {
    if (browser.child.exitCode === null) {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(browser.child.pid), '/T', '/F'], { stdio: 'ignore' })
      else browser.child.kill('SIGKILL')
    }
  } catch {}
  for (let attempt = 0; attempt < 8; attempt++) {
    try { await fsp.rm(browser.profile, { recursive: true, force: true }); break } catch { await delay(300) }
  }
}

async function connectPage(browser, httpPort, panelUrlPath, width, height) {
  const created = await fetch(`${browser.endpoint}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
  if (!created.ok) throw new Error(`could not create page: ${created.status}`)
  const target = await created.json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('page WebSocket failed')), { once: true })
  })
  const cdp = new Cdp(ws)
  cdp.targetId = target.id
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
    screenWidth: width, screenHeight: height
  })
  return cdp
}

async function navigate(cdp, url) {
  let resolveLoad
  const loaded = new Promise((resolve) => { resolveLoad = resolve })
  const off = cdp.on('Page.loadEventFired', () => resolveLoad())
  try {
    await cdp.send('Page.navigate', { url })
    await Promise.race([loaded, delay(15000).then(() => { throw new Error('navigation load timeout') })])
  } finally { off() }
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise, userGesture: true
  })
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text
    throw new Error(`page evaluate failed: ${text}`)
  }
  return result.result.value
}

async function waitPanelReady(cdp) {
  await waitFor(async () => {
    const s = await evaluate(cdp, `(() => {
      const h = window.__harness;
      if (!h) return null;
      const sel = document.querySelector('#chat-select');
      const bodyText = (document.body.innerText || '').trim();
      return {
        domReady: h.state.domReady,
        inflight: h.state.inflight,
        requests: h.state.requests.length,
        hasUi: !!(document.querySelector('#overview, #metrics') || sel),
        textLen: bodyText.length,
        overviewLen: (document.querySelector('#overview')?.innerText || '').trim().length
      };
    })()`)
    return s && s.domReady && s.inflight === 0 && s.requests > 0 && s.hasUi && s.textLen > 0
  }, 20000, 100, 'panel to render')
  await evaluate(cdp, 'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true', true).catch(() => {})
  await delay(200)
}

// ---------------------------------------------------------------------------
// Page inspection and assertions.
// ---------------------------------------------------------------------------
const inspectScript = `(() => {
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const textOf = (e) => e ? norm(e.innerText || e.textContent) : '';
  const q = (s) => document.querySelector(s);
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const rectOf = (e) => { const r = e.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) }; };
  const styleOf = (e) => { const s = getComputedStyle(e); return { display: s.display, position: s.position, overflowX: s.overflowX, color: s.color, background: s.backgroundColor, borderStyle: s.borderTopStyle }; };
  const select = q('#chat-select');
  const picker = q('#picker');
  const overview = q('#overview');
  const metrics = q('#metrics');
  const viewportOverflow = [];
  const parentOverflow = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (el.closest('details:not([open])') && el.tagName !== 'SUMMARY') continue;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    if (s.position === 'fixed' || s.position === 'absolute') continue;
    if (r.right > vw + 1 || r.left < -1) viewportOverflow.push({ tag: el.tagName.toLowerCase(), id: el.id, cls: String(el.className || '').slice(0, 60), text: textOf(el).slice(0, 60), rect: rectOf(el) });
    const p = el.parentElement;
    if (p && p !== document.body && p !== document.documentElement) {
      const ps = getComputedStyle(p);
      if (ps.overflowX === 'visible') {
        const pr = p.getBoundingClientRect();
        if (pr.width > 0 && (r.right > pr.right + 1 || r.left < pr.left - 1)) {
          parentOverflow.push({ tag: el.tagName.toLowerCase(), id: el.id, cls: String(el.className || '').slice(0, 60), text: textOf(el).slice(0, 60), over: +(r.right - pr.right).toFixed(1) });
        }
      }
    }
  }
  const uniq = (rows) => { const seen = new Set(); return rows.filter((row) => { const k = row.tag + '|' + row.id + '|' + row.cls + '|' + row.text; if (seen.has(k)) return false; seen.add(k); return true; }); };
  const details = [...document.querySelectorAll('details')].map((d) => ({ open: d.open, summary: textOf(d.querySelector('summary')), text: textOf(d).slice(0, 400) }));
  const metricCards = [...document.querySelectorAll('#metrics > *, #metrics [data-metric], .metric, .metric-card')].map((e) => ({ tag: e.tagName.toLowerCase(), cls: String(e.className || ''), text: textOf(e).slice(0, 300), style: styleOf(e) })).slice(0, 24);
  const plot = q('.cg-plot');
  const plotRect = plot ? rectOf(plot) : null;
  const tiles = plot ? [...plot.querySelectorAll('.cg-tile')].map((e) => ({ rect: rectOf(e), style: { top: e.style.top, left: e.style.left, width: e.style.width, height: e.style.height } })) : [];
  const overflowingTiles = plotRect ? tiles.filter(({ rect: t }) => t.x < plotRect.x - 1 || t.y < plotRect.y - 1 || t.right > plotRect.right + 1 || t.bottom > plotRect.bottom + 1) : [];
  const map = plot ? {
    rect: plotRect,
    plot: { styleHeight: plot.style.height, clientWidth: plot.clientWidth, clientHeight: plot.clientHeight, scrollWidth: plot.scrollWidth, scrollHeight: plot.scrollHeight },
    tiles,
    overflowingTiles,
    legendRows: document.querySelectorAll('.cg-legend li').length,
    modeButtons: [...document.querySelectorAll('.cg-mode')].map((b) => ({ text: textOf(b), pressed: b.getAttribute('aria-pressed'), disabled: b.getAttribute('aria-disabled') }))
  } : null;
  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang,
    vw, vh,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    htmlClass: document.documentElement.className,
    hasDarkClass: document.documentElement.classList.contains('dark'),
    hasLightClass: document.documentElement.classList.contains('light'),
    dataTheme: document.documentElement.getAttribute('data-theme'),
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    mediaDark: matchMedia('(prefers-color-scheme: dark)').matches,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    htmlBg: getComputedStyle(document.documentElement).backgroundColor,
    bodyColor: getComputedStyle(document.body).color,
    select: select ? { value: select.value, disabled: select.disabled, options: [...select.options].map((o) => ({ value: o.value, text: norm(o.textContent), selected: o.selected, disabled: o.disabled })), rect: rectOf(select), style: styleOf(select) } : null,
    picker: picker ? { hidden: picker.hidden, rect: rectOf(picker), style: styleOf(picker) } : null,
    overview: overview ? { text: textOf(overview), rect: rectOf(overview), html: overview.innerHTML.slice(0, 3000) } : null,
    metrics: metrics ? { text: textOf(metrics), rect: rectOf(metrics), html: metrics.innerHTML.slice(0, 4000) } : null,
    bodyText: norm(document.body.innerText).slice(0, 8000),
    details,
    metricCards,
    map,
    viewportOverflow: uniq(viewportOverflow).slice(0, 12),
    parentOverflow: uniq(parentOverflow).slice(0, 12),
    errors: window.__harness ? window.__harness.state.errors.slice(0, 20) : ['missing window.__harness'],
    logs: window.__harness ? window.__harness.state.logs.slice(0, 40) : [],
    requests: window.__harness ? window.__harness.state.requests.slice(-30) : []
  };
})()`

function parseColor(value) {
  const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)/i.exec(String(value || ''))
  if (!m) return null
  const alpha = m[4] === undefined ? 1 : Number(m[4])
  if (!alpha) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}
function luminance(rgb) {
  if (!rgb) return null
  const lin = rgb.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}
const compact = (n) => n < 1000 ? String(n) : n < 999950 ? `${+(n / 1000).toFixed(1)}k` : `${+(n / 1e6).toFixed(2)}M`
const count = (n) => new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(n)
function hasNumber(text, n) {
  const forms = new Set([String(n), count(n), compact(n)])
  forms.add(String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','))
  return [...forms].some((form) => text.includes(form))
}
function hasPercent(text, value) {
  const rounded = Math.round(value)
  const re = new RegExp(`(^|[^\\d.])${rounded}(?:\\.0+)?\\s*%`)
  return re.test(text)
}
function hasRate(text, value) {
  const one = value.toFixed(1)
  const forms = [one, String(Math.round(value))]
  return forms.some((form) => new RegExp(`(^|[^\\d.])${form.replace('.', '\\.')}(?![\\d])`).test(text))
}

function checkCase({ scenario, theme, width, view, beforeSwitch, afterSwitch, expected, pickerOpened }) {
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail })
  const soft = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail, soft: true })

  add('viewport width', Math.abs(view.vw - width) <= 1, `${view.vw}px (asked ${width}px)`)
  add('no document horizontal scroll', view.scrollWidth <= width + 1, `scrollWidth ${view.scrollWidth} vs ${width}`)
  add('no body horizontal scroll', view.bodyScrollWidth <= width + 1, `body scrollWidth ${view.bodyScrollWidth} vs ${width}`)
  add('no element past viewport', view.viewportOverflow.length === 0, view.viewportOverflow)
  add('no element past its container', view.parentOverflow.length === 0, view.parentOverflow)
  add('#overview present', !!view.overview, view.overview ? view.overview.rect : null)
  add('#metrics present', !!view.metrics, view.metrics ? view.metrics.rect : null)
  add('#chat-select present', !!view.select, view.select ? view.select.rect : null)
  add('no page errors', view.errors.length === 0, view.errors)
  add('gauge.get requested', view.requests.some((r) => r.name === 'gauge.get'), view.requests.map((r) => r.name))

  const bg = parseColor(view.bodyBg) || parseColor(view.htmlBg)
  const lum = luminance(bg)
  if (theme === 'dark') {
    add('dark surface', lum !== null && lum < 0.4, `bg ${view.bodyBg || view.htmlBg}, luminance ${lum && lum.toFixed(3)}`)
    add('html dark class', view.hasDarkClass, `class="${view.htmlClass}"`)
  } else if (theme === 'light') {
    add('light surface', lum !== null && lum > 0.6, `bg ${view.bodyBg || view.htmlBg}, luminance ${lum && lum.toFixed(3)}`)
    add('no unexpected dark class', !view.hasDarkClass, `class="${view.htmlClass}"`)
  } else if (theme === 'auto' && expected.osScheme === 'dark') {
    add('dark surface via OS fallback', lum !== null && lum < 0.4, `bg ${view.bodyBg || view.htmlBg}, luminance ${lum && lum.toFixed(3)}`)
    soft('auto leaves theme classes off', !view.hasDarkClass && !view.hasLightClass, `class="${view.htmlClass}"`)
  } else {
    add('light surface via OS fallback', lum !== null && lum > 0.6, `bg ${view.bodyBg || view.htmlBg}, luminance ${lum && lum.toFixed(3)}`)
    soft('auto leaves theme classes off', !view.hasDarkClass && !view.hasLightClass, `class="${view.htmlClass}"`)
  }

  const overviewText = view.overview?.text || ''
  const metricsText = view.metrics?.text || ''
  const selectOptions = view.select?.options || []
  add('chat options populated', selectOptions.length >= expected.chatCount, `${selectOptions.length} option(s): ${selectOptions.map((o) => o.text).join(' | ')}`)
  if (expected.selected) {
    add('selected chat marked', selectOptions.some((o) => o.value === expected.selected && o.selected), `selected="${view.select?.value}"`)
  }

  if (expected.used !== undefined) add('overview shows used tokens', hasNumber(overviewText, expected.used), `${expected.used} in "${overviewText.slice(0, 220)}"`)
  if (expected.window !== undefined) add('overview shows window', hasNumber(overviewText, expected.window), `${expected.window} in "${overviewText.slice(0, 220)}"`)
  if (expected.percent !== undefined) add('overview shows percent', hasPercent(overviewText, expected.percent), `${Math.round(expected.percent)}% in "${overviewText.slice(0, 220)}"`)

  if (expected.rate !== undefined) {
    add('metrics shows throughput', hasRate(metricsText, expected.rate), `${expected.rate.toFixed(1)} tok/s in "${metricsText.slice(0, 260)}"`)
  }
  if (expected.rateMissing) {
    add('no invented throughput', !/(tok\s*\/\s*s|tokens?\/s)/i.test(metricsText), `metrics text: "${metricsText.slice(0, 260)}"`)
    add('missing throughput explained', /(not available|unavailable|no (?:timing|request|data)|none|—|暂无|不可用|未提供|为什么|why)/i.test(metricsText), `metrics text: "${metricsText.slice(0, 260)}"`)
  }
  if (expected.cache !== undefined) {
    const oneDecimal = `${expected.cache.toFixed(1)}%`
    const twoDecimals = `${expected.cache.toFixed(2)}%`
    add('metrics shows cache hit rate', metricsText.includes(oneDecimal) || metricsText.includes(twoDecimals) || hasPercent(metricsText, expected.cache), `${oneDecimal} / ${twoDecimals} in "${metricsText.slice(0, 260)}"`)
  }
  if (expected.cacheMissing) {
    add('no invented cache metric', !/(cache hit|prompt cache|缓存命中)/i.test(metricsText), `metrics text: "${metricsText.slice(0, 260)}"`)
  }
  if (expected.breakdownMissing) {
    soft('breakdown absence explained', /(has not reported|without a breakdown|no breakdown|no category|未报告|没有分类|无分类|不提供)/i.test(view.bodyText), 'searched body text for a breakdown-unavailable message')
  }
  if (expected.map) {
    add('context map rendered', !!view.map && view.map.tiles.length > 0, view.map ? `${view.map.tiles.length} tile(s)` : 'no .cg-plot')
    // A very small tile's CSS padding can exceed its computed height, so its border box is
    // clipped by .cg-plot's overflow:hidden. That is a visual edge case, not page overflow.
    soft('map tiles stay inside the plot', !!view.map && view.map.overflowingTiles.length === 0, view.map ? view.map.overflowingTiles.slice(0, 6) : 'no .cg-plot')
    add('map legend rows', !!view.map && view.map.legendRows >= expected.legendRows, view.map ? `${view.map.legendRows} row(s), expected >= ${expected.legendRows}` : 'no .cg-plot')
    add('map mode controls', !!view.map && view.map.modeButtons.length >= 2, view.map ? view.map.modeButtons : 'no .cg-plot')
  }
  if (expected.mapMissing) {
    add('no map without a breakdown', !view.map, view.map ? `${view.map.tiles.length} unexpected tile(s)` : '')
  }
  if (expected.unavailableMessage) {
    soft('source/unavailable message present', expected.unavailableMessage.test(view.bodyText), 'searched body text')
  }

  if (beforeSwitch) {
    add('switch control opened picker', pickerOpened, `picker hidden: ${beforeSwitch.picker?.hidden}`)
    add('chat switching changed post', afterSwitch.requests.some((r) => r.name === 'gauge.select' && r.input && r.input.id === expected.switchTo), afterSwitch.requests.map((r) => `${r.name}:${r.input?.id ?? ''}`))
    add('select shows switched chat', afterSwitch.select?.value === expected.switchTo, `value="${afterSwitch.select?.value}"`)
    add('overview changed after switch', afterSwitch.overview?.text !== beforeSwitch.overview?.text, `before="${(beforeSwitch.overview?.text || '').slice(0, 120)}" after="${(afterSwitch.overview?.text || '').slice(0, 120)}"`)
    if (expected.switchUsed !== undefined) add('switched overview shows new tokens', hasNumber(afterSwitch.overview?.text || '', expected.switchUsed), `${expected.switchUsed} in "${(afterSwitch.overview?.text || '').slice(0, 220)}"`)
    if (expected.switchRate !== undefined) add('switched metrics shows new rate', hasRate(afterSwitch.metrics?.text || '', expected.switchRate), `${expected.switchRate.toFixed(1)} tok/s in "${(afterSwitch.metrics?.text || '').slice(0, 220)}"`)
    add('switched render error-free', afterSwitch.errors.length === 0, afterSwitch.errors)
  }
  return checks
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    widths: [260, 320, 400],
    themes: ['light', 'dark'],
    scenarios: ['detailed', 'missing'],
    auto: true,
    panel: null,
    json: false,
    wait: 0,
    height: 900,
    screenshots: true
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--widths') opts.widths = next().split(',').map(Number).filter((n) => n > 0)
    else if (arg === '--themes') opts.themes = next().split(',').filter(Boolean)
    else if (arg === '--scenario' || arg === '--scenarios') opts.scenarios = next().split(',').filter(Boolean)
    else if (arg === '--panel') opts.panel = next()
    else if (arg === '--json') opts.json = true
    else if (arg === '--wait') opts.wait = Number(next()) || 0
    else if (arg === '--height') opts.height = Number(next()) || 900
    else if (arg === '--no-screenshots') opts.screenshots = false
    else if (arg === '--no-auto') opts.auto = false
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

function usage() {
  return [
    'Usage: node scripts/check-panel.mjs [options]',
    '',
    '  --widths 260,320,400   panel widths in CSS px (default: all three)',
    '  --themes light,dark    explicit themes to test (default: light,dark)',
    '  --scenario detailed,missing  scenarios (default: detailed,missing)',
    '  --panel <path>         panel HTML (default: src/panel.html)',
    '  --height <px>          viewport height (default: 900)',
    '  --wait <seconds>       wait for the panel implementation before starting',
    '  --no-auto              skip the OS prefers-color-scheme fallback cases',
    '  --no-screenshots       skip PNG output',
    '  --json                 machine-readable summary'
  ].join('\n')
}

function pendingMessage(panelPath) {
  return [
    'Chat Gauge HTML panel implementation is not present yet; nothing was rendered.',
    `  expected panel:  ${path.relative(ROOT, panelPath)}`,
    `  expected module: ${path.relative(ROOT, EXPECTED_MODULE)}`,
    '',
    'Bridge contract the harness provides to the panel:',
    '  window.orca.plugin.request("gauge.get", undefined) -> Snapshot',
    '  window.orca.plugin.request("gauge.select", { id }) -> Snapshot (and emits gauge.changed)',
    '  window.orca.plugin.on("gauge.changed", fn) -> { dispose() }',
    '  window.orca.on("theme", fn); orca.locale; orca.env.theme; orca.settings/storage/host',
    '  theme: <html class="dark"> for dark, no class + prefers-color-scheme for OS fallback',
    '  expected DOM: <select id="chat-select">, #overview, #metrics',
    '',
    'Re-run with --wait <seconds> to poll, or wire the files and run again.'
  ].join('\n')
}

async function filesReady(panelPath) {
  if (!isFile(panelPath)) return false
  const html = readFileSync(panelPath, 'utf8')
  const referencesExpected = /html-panel\.ts/.test(html)
  // Accept a panel that does not reference html-panel.ts if the module exists anyway.
  return referencesExpected ? isFile(EXPECTED_MODULE) : true
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { console.log(usage()); return 0 }
  const panelPath = opts.panel ? path.resolve(ROOT, opts.panel) : DEFAULT_PANEL
  mkdirSync(OUT_DIR, { recursive: true })

  if (!(await filesReady(panelPath))) {
    if (opts.wait > 0) {
      try {
        await waitFor(() => filesReady(panelPath), opts.wait * 1000, 1000, 'panel implementation files')
      } catch {
        console.error(pendingMessage(panelPath))
        return 3
      }
    } else {
      console.error(pendingMessage(panelPath))
      return 3
    }
  }

  const browserPath = findBrowser()
  if (!browserPath) throw new Error('No Edge or Chrome found. Set EDGE_PATH or CHROME_PATH.')

  const panelUrlPath = '/' + path.relative(ROOT, panelPath).replaceAll('\\', '/')
  const { server, port: httpPort, address } = await startServer(panelPath)
  if (address !== '127.0.0.1') throw new Error(`static server must bind loopback, got ${address}`)
  await verifyServerLockdown(httpPort, panelUrlPath)
  let browser
  let cdp
  const results = []
  try {
    browser = await launchBrowser(browserPath)
    cdp = await connectPage(browser, httpPort, panelUrlPath, opts.widths[0], opts.height)

    const themes = [...opts.themes]
    if (opts.auto) themes.push('auto')
    const cases = []
    const scenarioList = opts.scenarios
    for (const scenario of scenarioList) {
      for (const theme of themes) {
        for (const width of opts.widths) {
          cases.push({ scenario, theme, width })
        }
      }
    }

    for (const { scenario, theme, width } of cases) {
      const scenarioDef = SCENARIOS[scenario]
      if (!scenarioDef) throw new Error(`unknown scenario: ${scenario}`)
      // Auto cases: cover both OS fallback directions by width.
      const autoScheme = theme === 'auto' ? (width === 320 || width === 400 ? 'dark' : 'light') : undefined
      const query = new URLSearchParams({ theme: theme === 'auto' ? 'auto' : theme, scenario })
      if (theme === 'auto') query.set('os', autoScheme)
      const url = `http://127.0.0.1:${httpPort}${panelUrlPath}?${query}`
      // Explicit themes emulate the opposite OS scheme, so a dark/light surface proves the
      // html.dark/html.light class is doing the work. Auto themes emulate the OS scheme itself.
      const emulatedScheme = theme === 'dark' ? 'light' : theme === 'light' ? 'dark' : autoScheme
      try {
        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: emulatedScheme }], media: ''
        })
      } catch { /* older builds: JS matchMedia override still covers script checks */ }
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height: opts.height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: opts.height
      })
      await navigate(cdp, url)
      await waitPanelReady(cdp)
      const view = await evaluate(cdp, inspectScript)

      if (opts.screenshots) {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
        await fsp.writeFile(path.join(OUT_DIR, `${scenario}-${theme}-${width}.png`), Buffer.from(shot.data, 'base64'))
      }

      let beforeSwitch = null
      let afterSwitch = null
      let expectedSwitch = null
      let pickerOpened = false
      if (scenario === 'detailed' && view.select && view.select.options.length > 1 && (theme === 'light' || theme === 'dark')) {
        const target = view.select.options.find((o) => o.value !== view.select.value && !o.disabled)
        if (target) {
          beforeSwitch = view
          // Use the real control first: "Switch chat" reveals the picker.
          const opened = await evaluate(cdp, `(() => {
            const picker = document.getElementById('picker');
            if (!picker) return { ok: false, reason: 'no #picker' };
            if (!picker.hidden) return { ok: true, already: true };
            const toggle = document.getElementById('change-chat');
            if (!toggle) return { ok: false, reason: 'no #change-chat control' };
            toggle.click();
            return { ok: true, clicked: true };
          })()`)
          if (!opened.ok) throw new Error(`chat picker failed: ${opened.reason}`)
          await waitFor(
            () => evaluate(cdp, `!document.getElementById('picker')?.hidden`),
            4000, 50, 'chat picker to open'
          )
          pickerOpened = true
          if (opts.screenshots && width === 320) {
            const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
            await fsp.writeFile(path.join(OUT_DIR, `${scenario}-${theme}-${width}-picker.png`), Buffer.from(shot.data, 'base64'))
          }
          const switched = await evaluate(cdp, `(() => {
            const s = document.getElementById('chat-select');
            if (!s) return { ok: false, reason: 'no #chat-select' };
            const option = [...s.options].find((o) => o.value === ${JSON.stringify(target.value)});
            if (!option) return { ok: false, reason: 'option missing' };
            s.value = option.value;
            s.dispatchEvent(new Event('input', { bubbles: true }));
            s.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, value: s.value };
          })()`)
          if (!switched.ok) throw new Error(`chat switch failed: ${switched.reason}`)
          await waitFor(async () => {
            const s = await evaluate(cdp, `({ inflight: window.__harness.state.inflight, value: document.getElementById('chat-select')?.value, text: (document.querySelector('#overview')?.innerText || '') })`)
            return s.inflight === 0 && s.value === target.value && s.text.length > 0
          }, 10000, 100, 'chat switch to settle')
          await waitFor(async () => {
            const reqs = await evaluate(cdp, 'window.__harness.state.requests.slice(-12)')
            return reqs.some((r) => r.name === 'gauge.select' && r.input && r.input.id === target.value)
          }, 5000, 100, 'gauge.select request')
          await delay(250)
          afterSwitch = await evaluate(cdp, inspectScript)
          expectedSwitch = target.value
          if (opts.screenshots) {
            const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
            await fsp.writeFile(path.join(OUT_DIR, `${scenario}-${theme}-${width}-switch.png`), Buffer.from(shot.data, 'base64'))
          }
        }
      }

      const expected = buildExpectations(scenario)
      expected.osScheme = autoScheme
      if (afterSwitch && expectedSwitch) {
        expected.switchTo = expectedSwitch
        const switched = buildExpectations(scenario, expectedSwitch)
        expected.switchUsed = switched.used
        expected.switchRate = switched.rate
      }
      const checks = checkCase({
        scenario, theme: theme === 'auto' ? 'auto' : theme, width, view,
        beforeSwitch, afterSwitch, expected, pickerOpened
      })
      results.push({
        scenario, theme, width, osScheme: autoScheme || theme,
        url, checks,
        view: {
          title: view.title, htmlClass: view.htmlClass, bodyBg: view.bodyBg, bodyColor: view.bodyColor,
          select: view.select, overview: view.overview?.text, metrics: view.metrics?.text,
          viewportOverflow: view.viewportOverflow, parentOverflow: view.parentOverflow,
          map: view.map, errors: view.errors, requests: view.requests
        },
        switch: beforeSwitch ? {
          target: expectedSwitch,
          before: { overview: beforeSwitch.overview?.text, metrics: beforeSwitch.metrics?.text },
          after: { overview: afterSwitch.overview?.text, metrics: afterSwitch.metrics?.text }
        } : null
      })
    }
  } finally {
    if (cdp) {
      try { await fetch(`${browser.endpoint}/json/close/${cdp.targetId}`) } catch {}
      cdp.close()
    }
    if (browser) await closeBrowser(browser)
    await new Promise((resolve) => server.close(resolve))
  }

  const failures = results.flatMap((r) => r.checks.filter((c) => !c.ok && !c.soft).map((c) => ({ ...c, scenario: r.scenario, theme: r.theme, width: r.width })))
  const softFailures = results.flatMap((r) => r.checks.filter((c) => !c.ok && c.soft).map((c) => ({ ...c, scenario: r.scenario, theme: r.theme, width: r.width })))
  const reportPath = path.join(OUT_DIR, 'report.json')
  await fsp.writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), panel: path.relative(ROOT, panelPath), results, failures, softFailures }, null, 2))

  if (opts.json) {
    console.log(JSON.stringify({ ok: failures.length === 0, panel: path.relative(ROOT, panelPath), results, failures, softFailures, report: reportPath }, null, 2))
  } else {
    for (const r of results) {
      const bad = r.checks.filter((c) => !c.ok)
      const hard = bad.filter((c) => !c.soft)
      const mark = hard.length ? 'FAIL' : 'PASS'
      console.log(`${mark}  ${r.scenario}/${r.theme}/${r.width}px  ${r.checks.length - bad.length}/${r.checks.length} checks`)
      for (const c of bad) console.log(`      ${c.soft ? 'warn' : 'FAIL'} ${c.name}: ${formatDetail(c.detail)}`)
      if (r.switch) console.log(`      switch -> ${r.switch.target}: ${r.switch.after.overview?.slice(0, 100)}`)
    }
    console.log('')
    console.log(`Screenshots: ${opts.screenshots ? path.relative(ROOT, OUT_DIR) : '(disabled)'}`)
    console.log(`Report: ${path.relative(ROOT, reportPath)}`)
    if (softFailures.length) console.log(`Soft warnings: ${softFailures.length}`)
    console.log(failures.length ? `FAILED: ${failures.length} hard check(s)` : 'All hard checks passed.')
  }
  return failures.length ? 1 : 0
}

function buildExpectations(scenario, selectedId = 'example') {
  if (scenario === 'detailed') {
    const byChat = {
      example: { used: 93911, window: 100000, percent: 94, rate: 13.9, cache: 96.16, map: true, legendRows: 4 },
      other: { used: 12400, window: 200000, percent: 6, rate: 40, cacheMissing: true, breakdownMissing: true, mapMissing: true },
      agy: { used: 364588, window: 1048576, percent: 35, rateMissing: true, cacheMissing: true, breakdownMissing: true, mapMissing: true }
    }
    return { chatCount: 3, selected: selectedId, ...byChat[selectedId] }
  }
  if (scenario === 'missing') {
    return {
      chatCount: 1, selected: 'agy', used: 364588, window: 1048576, percent: 35,
      rateMissing: true, cacheMissing: true, breakdownMissing: true, mapMissing: true,
      unavailableMessage: /(without a breakdown|has not reported|没有分类|未报告|no breakdown|no category)/i
    }
  }
  if (scenario === 'no-context') {
    return { chatCount: 1, selected: 'example', rate: 30, cacheMissing: true, used: undefined }
  }
  if (scenario === 'empty') return { chatCount: 0 }
  if (scenario === 'choose') return { chatCount: 3 }
  return {}
}

function formatDetail(detail) {
  if (detail === undefined) return ''
  if (typeof detail === 'string') return detail
  try {
    const text = JSON.stringify(detail)
    return text.length > 600 ? text.slice(0, 600) + '…' : text
  } catch { return String(detail) }
}

main()
  .then((code) => { process.exitCode = code })
  .catch((e) => {
    console.error('check-panel failed:', e && e.stack || e)
    process.exitCode = 1
  })
