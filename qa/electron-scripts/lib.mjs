import { createRequire } from 'node:module'
import { rmSync, mkdirSync, appendFileSync } from 'node:fs'
const require = createRequire('/home/user/Mikka/package.json')
export const { _electron: electron, chromium } = require('@playwright/test')
export const APP = 'http://localhost:3100/mikka'
export const ORIGIN = 'http://localhost:3100'
export const OUT = '/home/qa/run/out'
mkdirSync(`${OUT}/shots`, { recursive: true })
export const log = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(s); appendFileSync(`${OUT}/log.txt`, s + '\n') }
export const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function launch(userData = '/tmp/qa-electron', { fresh = false } = {}) {
  if (fresh) rmSync(userData, { recursive: true, force: true })
  for (const n of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort']) rmSync(`${userData}/${n}`, { force: true })
  const env = { ...process.env, MIKKA_USER_DATA_DIR: userData, LANG: 'zh_CN.UTF-8', LANGUAGE: 'zh_CN' }
  delete env.NODE_OPTIONS
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`, '--lang=zh-CN'], cwd: '/home/user/Mikka/apps/desktop', env, timeout: 90_000 })
  const mainLogs = []
  const proc = app.process()
  proc.stdout.on('data', d => mainLogs.push(...String(d).split('\n').filter(Boolean).map(l => ['stdout', l])))
  proc.stderr.on('data', d => mainLogs.push(...String(d).split('\n').filter(Boolean).filter(l => !/dbus|bus\.cc|object_proxy/.test(l)).map(l => ['stderr', l])))
  // Capture system-browser opens instead of launching a browser.
  await app.evaluate(({ shell }) => {
    globalThis.__opened = []
    shell.openExternal = async url => { globalThis.__opened.push(url) }
  })
  const page = await app.firstWindow({ timeout: 90_000 })
  return { app, page, mainLogs }
}
export const opened = app => app.evaluate(() => globalThis.__opened.slice())
export const clearOpened = app => app.evaluate(() => { globalThis.__opened.length = 0 })
