#!/usr/bin/env node
/**
 * Builds the store listing images from synthetic panel captures (no real chats, titles or paths):
 *   assets/icon.png                      256x256
 *   assets/screenshots/{light,dark}.png  1280x800, English and Chinese panels side by side
 *
 * Step 1: capture the panel at 2x for each language and theme (copies go to .orca/shots):
 *   node scripts/check-panel.mjs --scenario detailed --widths 360 --themes light,dark --no-auto --height 800 --scale 2 --locale en
 *   (copy .orca/check/detailed-<theme>-360.png to .orca/shots/en-<theme>.png; repeat with --locale zh-CN -> zh-<theme>.png)
 * Step 2: node scripts/store-assets.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shots = path.join(root, '.orca', 'shots'), work = path.join(root, '.orca', 'store')
const browser = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync)
if (!browser) throw new Error('Edge or Chrome is required')
mkdirSync(work, { recursive: true }); mkdirSync(path.join(root, 'assets', 'screenshots'), { recursive: true })

let profiles = 0
function render(html, out, width, height, transparent = false) {
  const page = path.join(work, path.basename(out, '.png') + '.html')
  writeFileSync(page, html); rmSync(out, { force: true })
  execFileSync(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${path.join(work, 'profile-' + ++profiles)}`, '--force-device-scale-factor=1', '--virtual-time-budget=3000', `--window-size=${width},${height}`,
    ...(transparent ? ['--default-background-color=00000000'] : []), `--screenshot=${out}`, pathToFileURL(page).href], { stdio: 'ignore' })
  // The new headless mode can exit before the PNG is flushed; wait for a stable file.
  let last = -1
  for (let i = 0; i < 100; i++) {
    const size = existsSync(out) ? statSync(out).size : 0
    if (size > 0 && size === last) return
    last = size; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  }
  throw new Error(`screenshot not written: ${out}`)
}
const data = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`

// Gauge mark: a rounded square with a ring, a filled arc and a needle.
const icon = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:256px;height:256px;background:transparent}</style>
<svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#1e40af"/></linearGradient></defs>
<rect width="256" height="256" rx="56" fill="url(#g)"/>
<path d="M60 176 A80 80 0 1 1 196 176" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="22" stroke-linecap="round"/>
<path d="M60 176 A80 80 0 0 1 150 56" fill="none" stroke="#fff" stroke-width="22" stroke-linecap="round"/>
<line x1="128" y1="148" x2="164" y2="96" stroke="#fff" stroke-width="14" stroke-linecap="round"/>
<circle cx="128" cy="148" r="16" fill="#fff"/></svg>`
render(icon, path.join(root, 'assets', 'icon.png'), 256, 256, true)

const copy = {
  en: { sub: 'Context usage and throughput for local agent chats', points: ['Every chat in the workspace as a tab', 'Context window, cache hit rate, tok/s', 'Local read-only data, no model calls'] },
  zh: { sub: '本机 Agent 对话的上下文用量与吞吐', points: ['工作区全部对话一键切换', '上下文窗口、缓存命中率、tok/s', '只读本机数据，不调用模型'] }
}
for (const theme of ['light', 'dark']) {
  const dark = theme === 'dark', bg = dark ? '#16171a' : '#f3f5f9', fg = dark ? '#f2f1ed' : '#171816', muted = dark ? '#b9bbb4' : '#595a56', card = dark ? '#242523' : '#ffffff'
  const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:1280px;height:800px;overflow:hidden;background:${bg};color:${fg};font:16px/1.5 'Segoe UI','Microsoft YaHei',system-ui,sans-serif}
main{display:flex;align-items:center;gap:40px;height:800px;padding:0 56px;box-sizing:border-box}
section{width:440px}h1{margin:0 0 6px;font-size:48px;letter-spacing:-.02em}p{margin:0;color:${muted}}.sub{font-size:18px;color:${fg}}
ul{list-style:none;padding:0;margin:28px 0 0;display:grid;gap:14px}li{font-size:17px}li span{display:block;color:${muted};font-size:15px}
.panels{display:flex;gap:20px;margin-left:auto}figure{margin:0;width:324px;height:720px;border-radius:12px;overflow:hidden;background:${card};box-shadow:0 8px 28px rgba(0,0,0,${dark ? '.5' : '.14'})}
img{display:block;width:324px;height:720px;object-fit:cover;object-position:top}
</style><main><section><h1>Chat Gauge</h1><p class="sub">${copy.en.sub}</p><p>${copy.zh.sub}</p>
<ul>${copy.en.points.map((p, i) => `<li>${p}<span>${copy.zh.points[i]}</span></li>`).join('')}</ul></section>
<div class="panels"><figure><img src="${data(path.join(shots, `en-${theme}.png`))}"></figure><figure><img src="${data(path.join(shots, `zh-${theme}.png`))}"></figure></div></main>`
  render(html, path.join(root, 'assets', 'screenshots', `${theme}.png`), 1280, 800)
}
console.log('assets written')
