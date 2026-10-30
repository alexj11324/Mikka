// Daemon-backed calls, 本机, board reload, second-instance, offline page.
import { writeFileSync } from 'node:fs'
import { execSync, spawn } from 'node:child_process'
import { launch, log, sleep, OUT, APP, electron } from './lib.mjs'
const r = {}
const { app, page, mainLogs } = await launch('/tmp/qa-electron')
const errs = []
page.on('pageerror', e => errs.push(String(e))); page.on('console', m => m.type() === 'error' && errs.push(m.text().slice(0, 300)))
const go = async u => { await page.goto(u, { waitUntil: 'domcontentloaded' }); await page.waitForLoadState('networkidle').catch(() => {}); await sleep(1500) }
await go(`${APP}?section=coordinator`)
r.addFileButtons = await page.getByRole('button', { name: '添加文件' }).evaluateAll(bs => bs.map(b => { const x = b.getBoundingClientRect(); return [Math.round(x.x), Math.round(x.y), Math.round(x.width), b.disabled] }))
const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 6000 }).catch(e => null), page.getByRole('button', { name: '添加文件' }).last().click({ timeout: 6000 }).catch(e => { r.addFileErr = String(e).split('\n')[0] })])
r.fileChooser = fc ? { multiple: fc.isMultiple() } : 'no filechooser event'
await page.keyboard.press('Escape')
await go(APP)
r.device = await page.evaluate(() => window.mikka.device.status())
r.quota = await page.evaluate(() => window.mikka.quota.get().then(q => ({ observedAt: q.observedAt, n: q.quotas.length })))
await go(`${APP}/settings?section=computers`)
await page.waitForFunction(() => /本机|This machine/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {})
r.settingsHasLocal = await page.evaluate(() => /本机/.test(document.body.innerText))
r.computersText = (await page.locator('main, body').first().innerText()).slice(0, 600)
await page.screenshot({ path: `${OUT}/shots/check2-computers-本机.png` })
// Board then Ctrl+R (menu Reload)
await go(APP)
await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '看板' }).click(); await sleep(1500)
r.boardUrl = page.url()
await app.evaluate(({ Menu, BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; Menu.getApplicationMenu().items.find(i => i.label === 'View').submenu.items.find(i => i.label === 'Reload').click(undefined, w, w.webContents) })
await page.waitForLoadState('networkidle').catch(() => {}); await sleep(2500)
r.afterReload = { url: page.url(), current: await page.locator('[role=navigation] button[aria-current=page]').innerText().catch(() => null) }
await page.screenshot({ path: `${OUT}/shots/check2-board-after-reload.png` })
// Zoomed layout: Ctrl+= twice, check the rail bottom and composer still in view
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomLevel(1))
await go(APP); await sleep(1000)
r.zoomed = await page.evaluate(() => { const b = document.querySelector('[aria-label="工作区菜单"]')?.getBoundingClientRect(); return { inner: [innerWidth, innerHeight], menuBottom: b && b.bottom, scrollH: document.documentElement.scrollHeight } })
await page.screenshot({ path: `${OUT}/shots/check2-zoom1.png` })
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomLevel(0))
// Second instance: a second launch on the same profile must quit and focus the first.
const env = { ...process.env, MIKKA_USER_DATA_DIR: '/tmp/qa-electron' }; delete env.NODE_OPTIONS
const t0 = Date.now()
const code = await new Promise(res => { const p = spawn('/home/user/Mikka/node_modules/.pnpm/electron@45.1.0/node_modules/electron/dist/electron', ['.', '--user-data-dir=/tmp/qa-electron'], { cwd: '/home/user/Mikka/apps/desktop', env, stdio: 'ignore' }); p.on('exit', c => res(c)); setTimeout(() => { p.kill(); res('still running after 20s') }, 20000) })
r.secondInstance = { exit: code, ms: Date.now() - t0, windowsInFirst: await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) }
// Offline: stop the web server, reload, expect offline.html; restart, expect auto-return.
writeFileSync(`${OUT}/check2-partial.json`, JSON.stringify(r, null, 1))
log('PARTIAL', JSON.stringify(r))
r.errors = errs; r.mainLogs = mainLogs.filter(([, l]) => !/CreatePlatformSocket|ssl_client/.test(l)).slice(0, 40)
writeFileSync(`${OUT}/check2.json`, JSON.stringify(r, null, 1))
await app.close()
