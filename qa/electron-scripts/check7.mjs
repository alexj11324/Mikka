import { writeFileSync } from 'node:fs'
import { launch, log, sleep, OUT, APP, opened, clearOpened } from './lib.mjs'
const r = {}
const { app, page } = await launch('/tmp/qa-electron')
await page.goto(`${APP}?section=plugins`, { waitUntil: 'domcontentloaded' }); await page.waitForLoadState('networkidle').catch(() => {}); await sleep(2000)
r.links = await page.locator('a[href^="http"]').evaluateAll(as => as.map(a => [a.innerText.trim().slice(0, 30), a.href, a.target]).filter(([, h]) => !h.startsWith('http://localhost')))
await page.getByRole('tab', { name: '技能' }).click(); await sleep(2500)
const link = page.locator('a[href="https://skills.sh/"]').first()
r.skillsHref = await link.getAttribute('href').catch(() => null)
await clearOpened(app)
const before = page.url(); const w0 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
await link.click().catch(e => r.err = String(e).slice(0, 100)); await sleep(1500)
r.skillsClick = { opened: await opened(app), stayed: page.url() === before, windows: `${w0} -> ${await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)}` }
// An in-app http (non-TLS) external target, as a chat link would be.
await clearOpened(app)
await page.evaluate(() => { const a = document.createElement('a'); a.href = 'http://example.org/'; a.target = '_blank'; a.textContent = 'x'; document.body.appendChild(a); a.click(); a.remove() })
await sleep(1000)
r.httpBlankLink = { opened: await opened(app), url: page.url() }
writeFileSync(`${OUT}/check7.json`, JSON.stringify(r, null, 1)); log(JSON.stringify(r))
await app.close()
