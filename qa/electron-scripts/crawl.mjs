// Electron interaction crawl. Usage: node crawl.mjs <phase>
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { launch, opened, clearOpened, log, sleep, OUT, APP, ORIGIN, chromium } from './lib.mjs'

const USER = '/tmp/qa-electron'
const phase = process.argv[2] ?? 'all'
const findings = existsSync(`${OUT}/findings.json`) ? JSON.parse(readFileSync(`${OUT}/findings.json`, 'utf8')) : []
const results = existsSync(`${OUT}/results.json`) ? JSON.parse(readFileSync(`${OUT}/results.json`, 'utf8')) : {}
const save = () => { writeFileSync(`${OUT}/findings.json`, JSON.stringify(findings, null, 1)); writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1)) }
const acct = existsSync(`${OUT}/acct.json`) ? JSON.parse(readFileSync(`${OUT}/acct.json`, 'utf8')) : (() => { const a = { email: `qa-electron-${Date.now()}@example.com`, password: `Qa-${Math.random().toString(36).slice(2)}-pass1`, name: 'QA 桌面' }; writeFileSync(`${OUT}/acct.json`, JSON.stringify(a)); return a })()

const DESTRUCTIVE = /删除|delete|移除|remove|退出登录|登出|sign ?out|注销|付款|支付|购买|升级|upgrade|subscribe|订阅|发送邀请|邀请|invite|重置|reset|revoke|撤销|吊销|断开|disconnect|离开|leave|归档|archive|转让|transfer|google|github|linear|telegram|slack|composio|连接|connect|授权|authorize|发送|send|提交|submit|保存|save|创建|create|新建|确认|confirm|停止|stop|取消订阅|clear|清空|导出|export|下载|download|上传|upload|复制令牌|轮换|rotate|批准|approve|拒绝|deny/i

const { app, page, mainLogs } = await launch(USER, { fresh: phase === 'signup' || phase === 'all' })
page.setDefaultTimeout(20_000)
let ctx = 'boot'
const events = []
page.on('pageerror', e => events.push({ ctx, kind: 'pageerror', text: String(e).slice(0, 500) }))
page.on('console', m => { if (m.type() === 'error') events.push({ ctx, kind: 'console.error', text: m.text().slice(0, 500) }) })
page.on('response', r => { if (r.status() >= 500) events.push({ ctx, kind: `http ${r.status()}`, text: `${r.request().method()} ${r.url()}`.slice(0, 300) }) })
page.on('requestfailed', r => { const u = r.url(); if (u.startsWith(ORIGIN) && !/_rsc|ERR_ABORTED/.test(r.failure()?.errorText ?? '')) events.push({ ctx, kind: 'requestfailed', text: `${u} ${r.failure()?.errorText}`.slice(0, 300) }) })
const take = since => events.slice(since)
let shotN = 0
const shot = async name => { const p = `${OUT}/shots/${phase}-${String(++shotN).padStart(2, '0')}-${name}.png`.replace(/[^\w\/.\-]/g, '_'); await page.screenshot({ path: p }).catch(() => {}); return p.split('/').pop() }
async function goto(url) {
  for (let i = 0; i < 3; i++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }); break } catch (e) { if (i === 2) throw e; await sleep(1000) }
  }
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  await sleep(800)
}

async function signUpInApp() {
  ctx = 'signup'
  await goto(`${APP}/sign-up`)
  await shot('signup-page')
  await page.locator('input[name="name"]').fill(acct.name)
  await page.locator('input[name="email"]').fill(acct.email)
  await page.locator('input[name="password"]').fill(acct.password)
  const before = events.length
  await page.locator('form button[type="submit"]').click()
  await page.waitForURL(u => !/sign-up/.test(u.pathname), { timeout: 60_000 }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
  await sleep(2000)
  results.signup = { url: page.url(), errors: take(before), shot: await shot('after-signup') }
  log('signup ->', page.url())
  // A new account may land on workspace creation.
  if (/workspaces\/new|onboarding/.test(page.url())) {
    const input = page.locator('input').first()
    if (await input.count()) { await input.fill('QA 桌面工作区').catch(() => {}) }
    await page.locator('button[type="submit"], button:has-text("创建"), button:has-text("继续")').first().click().catch(() => {})
    await page.waitForLoadState('networkidle').catch(() => {}); await sleep(3000)
    results.signup.afterWorkspace = page.url()
  }
  save()
}

// ---------- generic crawler ----------
const ROLES = ['button', 'link', 'switch', 'checkbox', 'combobox', 'tab', 'menuitem', 'textbox', 'radio', 'slider', 'searchbox']
async function enumerate() {
  return page.evaluate(ROLES => {
    const sel = 'button,a[href],input,textarea,select,[role]'
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[aria-hidden="true"],[inert]') }
    const roleOf = el => {
      const r = el.getAttribute('role'); if (r) return r
      const t = el.tagName.toLowerCase()
      if (t === 'button') return 'button'
      if (t === 'a') return 'link'
      if (t === 'select') return 'combobox'
      if (t === 'textarea') return 'textbox'
      if (t === 'input') { const ty = (el.type || 'text').toLowerCase(); return ty === 'checkbox' ? 'checkbox' : ty === 'radio' ? 'radio' : ty === 'range' ? 'slider' : ['submit', 'button'].includes(ty) ? 'button' : ty === 'hidden' ? null : 'textbox' }
      return null
    }
    const out = []
    document.querySelectorAll('[data-qa-idx]').forEach(e => e.removeAttribute('data-qa-idx'))
    let i = 0
    for (const el of document.querySelectorAll(sel)) {
      const role = roleOf(el)
      if (!role || !ROLES.includes(role) || !visible(el)) continue
      const name = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 60)
      el.setAttribute('data-qa-idx', String(i))
      out.push({ i: i++, role, name, href: el.getAttribute('href'), target: el.getAttribute('target'), disabled: el.disabled || el.getAttribute('aria-disabled') === 'true', checked: el.getAttribute('aria-checked') ?? (el.checked ?? null) })
    }
    return out
  }, ROLES)
}
const sig = () => page.evaluate(() => document.body.innerText.length + ':' + document.querySelectorAll('*').length + ':' + document.querySelectorAll('[role=dialog],[role=menu],[role=listbox],[data-state=open]').length)
const overlayOpen = () => page.evaluate(() => document.querySelectorAll('[role=dialog],[role=alertdialog],[role=menu],[role=listbox]').length)

async function crawl(label, url, { cap = 45 } = {}) {
  ctx = label
  const rec = { label, url, items: [], loadErrors: [] }
  const e0 = events.length
  await goto(url)
  rec.finalUrl = page.url()
  rec.loadErrors = take(e0)
  rec.shot = await shot(`${label}-load`)
  const els = await enumerate()
  rec.total = els.length
  const seen = new Set()
  let done = 0
  for (const el of els) {
    if (done >= cap) break
    const key = `${el.role}|${el.name}`
    if (seen.has(key)) continue
    seen.add(key)
    const item = { role: el.role, name: el.name, href: el.href }
    rec.items.push(item)
    if (el.disabled) { item.result = 'disabled'; continue }
    if (DESTRUCTIVE.test(el.name) && el.role !== 'textbox' && el.role !== 'tab') { item.result = 'skipped-destructive'; continue }
    if (el.role === 'link' && el.href && !el.href.startsWith('/') && !el.href.startsWith(ORIGIN) && !el.href.startsWith('#')) {
      // external link: must open outside, not navigate the window.
      await clearOpened(app)
    }
    done++
    ctx = `${label} › ${el.role} "${el.name}"`
    const since = events.length
    const urlBefore = page.url()
    const loc = page.locator(`[data-qa-idx="${el.i}"]`)
    if (!(await loc.count())) { item.result = 'gone'; continue }
    const s0 = await sig().catch(() => '')
    const winsBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    try {
      if (el.role === 'textbox' || el.role === 'searchbox') {
        await loc.click({ timeout: 5000 }); await loc.fill('qa测试', { timeout: 5000 }); await sleep(400); await loc.fill('', { timeout: 5000 })
        item.result = 'typed'
      } else if (el.role === 'switch' || el.role === 'checkbox') {
        await loc.click({ timeout: 5000 }); await sleep(900)
        const after = await loc.getAttribute('aria-checked').catch(() => null) ?? String(await loc.isChecked().catch(() => null))
        item.toggled = `${el.checked} -> ${after}`
        if (String(el.checked) !== String(after)) { await loc.click({ timeout: 5000 }).catch(() => {}); await sleep(900) } // restore
        item.result = String(el.checked) === String(after) ? 'no-effect' : 'toggled+restored'
      } else if (el.role === 'slider') {
        await loc.focus(); await page.keyboard.press('ArrowRight'); await sleep(300); await page.keyboard.press('ArrowLeft'); item.result = 'nudged'
      } else {
        await loc.click({ timeout: 5000 })
        await sleep(1100)
        const u = page.url(), s1 = await sig().catch(() => '')
        const winsAfter = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
        const ext = await opened(app)
        if (ext.length) { item.result = 'opened-external'; item.external = ext.slice(-1)[0]; await clearOpened(app) }
        else if (winsAfter > winsBefore) { item.result = 'child-window'; await app.evaluate(({ BrowserWindow }) => { const ws = BrowserWindow.getAllWindows(); for (const w of ws.slice(1)) if (w.getParentWindow()) w.close() }) }
        else if (u !== urlBefore) item.result = `navigated ${new URL(u).pathname}${new URL(u).search}`
        else if (await overlayOpen()) item.result = 'overlay-opened'
        else if (s1 !== s0) item.result = 'dom-changed'
        else item.result = 'no-visible-effect'
        if (item.result === 'overlay-opened') {
          item.overlay = await page.evaluate(() => [...document.querySelectorAll('[role=dialog],[role=alertdialog],[role=menu],[role=listbox]')].map(d => d.innerText.trim().slice(0, 120)).join(' | '))
        }
      }
    } catch (e) {
      item.result = 'error'; item.error = String(e).split('\n')[0].slice(0, 200)
    }
    const errs = take(since)
    if (errs.length) item.errors = errs
    if (errs.length || item.result === 'error' || item.result === 'no-visible-effect') item.shot = await shot(`${label}-${el.role}-${el.name.slice(0, 20)}`)
    // reset state
    for (let k = 0; k < 2 && await overlayOpen().catch(() => 0); k++) { await page.keyboard.press('Escape'); await sleep(300) }
    if (page.url() !== urlBefore) { await goto(url); await enumerate() }
    else if (!(await page.locator('[data-qa-idx]').count())) await enumerate()
    else {
      // DOM may have re-rendered; re-tag without losing order if element is gone.
      const still = await page.locator(`[data-qa-idx]`).count()
      if (still < els.length / 2) await enumerate()
    }
  }
  rec.errors = events.filter((e, idx) => idx >= e0 && e.ctx.startsWith(label))
  log(`${label}: total=${rec.total} tried=${done} errors=${rec.errors.length}`)
  results.pages ??= {}
  results.pages[label] = rec
  save()
  return rec
}

// ---------- desktop checks ----------
async function desktopChecks() {
  const d = results.desktop ??= {}
  ctx = 'desktop'
  await goto(APP)
  d.webPreferences = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; const p = w.webContents.getLastWebPreferences(); return { contextIsolation: p.contextIsolation, sandbox: p.sandbox, nodeIntegration: p.nodeIntegration, nodeIntegrationInSubFrames: p.nodeIntegrationInSubFrames, webviewTag: p.webviewTag, webSecurity: p.webSecurity, title: w.getTitle(), menuBarVisible: w.isMenuBarVisible(), minSize: w.getMinimumSize() } })
  d.renderer = await page.evaluate(() => {
    const b = window.mikka
    let overwrite = 'n/a'
    try { b.app.runtime = 'hacked'; overwrite = b.app.runtime } catch (e) { overwrite = 'threw ' + e.message }
    return { require: typeof window.require, process: typeof window.process, module: typeof window.module, Buffer: typeof window.Buffer, ipcRenderer: typeof window.ipcRenderer, electron: typeof window.electron, bridgeKeys: b ? Object.keys(b) : null, appKeys: b ? Object.keys(b.app) : null, runtime: b?.app.runtime, flavor: b?.app.flavor, version: b?.app.version, serverUrl: b?.app.serverUrl, platformAttr: document.documentElement.dataset.desktopPlatform, overwriteRuntime: overwrite }
  })
  // IPC from a same-origin iframe must be refused; the preload must not be in subframes.
  d.iframe = await page.evaluate(async () => new Promise(res => {
    const f = document.createElement('iframe'); f.src = location.origin + '/mikka/sign-in'; f.style.display = 'none'
    f.onload = () => { try { res({ mikkaInIframe: typeof f.contentWindow.mikka }) } catch (e) { res({ err: String(e) }) } ; f.remove() }
    document.body.appendChild(f); setTimeout(() => res({ timeout: true }), 15000)
  }))
  d.device = await page.evaluate(() => window.mikka.device.status())
  d.quota = await page.evaluate(() => window.mikka.quota.get().then(q => ({ observedAt: q.observedAt, vendors: q.quotas.map(x => `${x.vendor}:${x.status}`) })))
  // openExternal policy
  d.openExternal = {}
  for (const u of ['https://example.com/x', `${ORIGIN}/mikka/sign-in`, 'file:///etc/passwd', 'javascript:alert(1)', 'http://evil.example/']) {
    await clearOpened(app)
    d.openExternal[u] = await page.evaluate(u => window.mikka.app.openExternal(u).then(() => 'resolved', e => 'rejected: ' + String(e.message).slice(0, 120)), u)
    d.openExternal[u] += ' | opened=' + JSON.stringify(await opened(app))
  }
  // prepareAuth validation
  d.prepareAuth = {}
  for (const s of ['short', 'A'.repeat(20), '../../etc/passwd_xxxxxxxx']) d.prepareAuth[s.slice(0, 24)] = await page.evaluate(s => window.mikka.app.prepareAuth(s).then(r => 'resolved ' + r, e => 'rejected ' + String(e.message).slice(0, 100)), s)
  // The listener: wrong path 404, wrong state 400 and closes.
  const cb = d.prepareAuth['AAAAAAAAAAAAAAAAAAAA']?.split(' ')[1]
  if (cb?.startsWith('http://127.0.0.1')) {
    const port = new URL(cb).port
    d.loopback = {}
    d.loopback.wrongPath = (await fetch(`http://127.0.0.1:${port}/other`).then(r => r.status).catch(e => 'ERR ' + e.message))
    d.loopback.badState = (await fetch(`${cb}?code=${'c'.repeat(40)}&state=${'B'.repeat(20)}`).then(r => r.status).catch(e => 'ERR ' + e.message))
    d.loopback.afterBadStateClosed = (await fetch(cb).then(r => 'still open ' + r.status).catch(() => 'closed'))
  }
  // Navigation policy in the main window.
  const urlBefore = page.url()
  await clearOpened(app)
  d.windowOpenExternal = await page.evaluate(() => { const w = window.open('https://example.com/from-window-open'); return w === null ? 'null' : 'window' })
  await sleep(800)
  d.windowOpenExternalOpened = await opened(app)
  await clearOpened(app)
  await page.evaluate(() => { location.href = 'https://example.com/from-location' }).catch(() => {})
  await sleep(1500)
  d.locationExternal = { url: page.url(), stayed: page.url() === urlBefore, opened: await opened(app) }
  await clearOpened(app)
  await page.evaluate(() => { location.href = 'http://example.org/plain-http' }).catch(() => {})
  await sleep(1500)
  d.locationHttpExternal = { url: page.url(), opened: await opened(app) }
  const w0 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  await page.evaluate(() => window.open('/mikka/settings?section=preferences'))
  await sleep(3000)
  d.windowOpenSameOrigin = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ url: w.webContents.getURL(), parent: !!w.getParentWindow(), menu: w.isMenuBarVisible() })))
  const child = app.windows().find(p => p !== page)
  if (child) { d.childBridge = await child.evaluate(() => ({ mikka: typeof window.mikka, platform: document.documentElement.dataset.desktopPlatform })).catch(e => String(e)); }
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.getParentWindow()) w.close() })
  d.windowCountBefore = w0
  // Notifications & badge
  d.notification = await app.evaluate(({ Notification, app }) => ({ supported: Notification.isSupported(), badgeBefore: app.getBadgeCount() }))
  d.notifyShow = await page.evaluate(() => window.mikka.notifications.show({ id: 'qa-1', kind: 'awaiting', title: 'QA 等你', body: '测试通知', href: '/mikka' }).then(() => 'resolved', e => 'rejected ' + e.message))
  d.notifyInvalid = await page.evaluate(() => window.mikka.notifications.show({ id: 'x', kind: 'awaiting', title: 't', body: 'b', href: 'https://evil.example' }).then(() => 'resolved', e => 'rejected ' + String(e.message).slice(0, 160)))
  d.badge = await page.evaluate(async () => { const r = []; for (const v of [3, -1, 1.5, 'x', 100000]) r.push(await window.mikka.notifications.setBadge(v).then(() => `${v}:ok`, e => `${v}:rejected`)); return r })
  d.badgeAfter = await app.evaluate(({ app }) => app.getBadgeCount())
  await page.evaluate(() => window.mikka.notifications.setBadge(0))
  d.pendingClick = await page.evaluate(() => window.mikka.notifications.consumePendingClick())
  // Simulate a notification click from main: renderer should route in-app.
  await goto(`${APP}/settings?section=preferences`)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('mikka:notifications:clicked', '/'))
  await sleep(2500)
  d.notificationClickRoutes = page.url()
  // Deep links / protocol
  d.protocol = await app.evaluate(({ app }) => ({ mikka: app.isDefaultProtocolClient('mikka'), name: app.getName(), version: app.getVersion(), locale: app.getLocale(), electron: process.versions.electron, chrome: process.versions.chrome, packaged: app.isPackaged }))
  d.menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map(i => ({ label: i.label, sub: i.submenu?.items.filter(s => s.visible).map(s => s.label || s.role) })))
  // Zoom shortcut via native input events
  const z0 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel())
  await app.evaluate(({ BrowserWindow }) => { const wc = BrowserWindow.getAllWindows()[0].webContents; wc.sendInputEvent({ type: 'keyDown', keyCode: '=', modifiers: ['control'] }); wc.sendInputEvent({ type: 'keyUp', keyCode: '=', modifiers: ['control'] }) })
  await sleep(600)
  const z1 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel())
  // Reset via menu item click to keep the rest steady.
  await app.evaluate(({ Menu, BrowserWindow }) => { const view = Menu.getApplicationMenu().items.find(i => i.label === 'View'); const reset = view.submenu.items.find(i => i.role === 'resetzoom'); reset.click(undefined, BrowserWindow.getAllWindows()[0]) })
  await sleep(400)
  const z2 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel())
  d.zoom = { before: z0, afterCtrlEquals: z1, afterResetMenu: z2 }
  // Request headers the shell adds.
  d.headers = await page.evaluate(async () => { const r = await fetch('/mikka/api/auth/get-session'); return r.status })
  // Rail: labels readable & positions
  await goto(APP)
  d.rail = await page.evaluate(() => { const nav = document.querySelector('[role=navigation][aria-label]'); if (!nav) return null; return { label: nav.getAttribute('aria-label'), items: [...nav.querySelectorAll('button')].map(b => { const r = b.getBoundingClientRect(); const s = b.querySelector('span:last-child'); const sr = s?.getBoundingClientRect(); return { text: b.innerText.trim(), w: Math.round(r.width), textW: sr ? Math.round(sr.width) : null, overflow: s ? s.scrollWidth > s.clientWidth + 1 : null, current: b.getAttribute('aria-current') } }) } })
  d.windowBar = await page.evaluate(() => { const b = document.querySelector('[data-slot=window-bar]'); if (!b) return null; const r = b.getBoundingClientRect(); return { h: r.height, display: getComputedStyle(b).display, appRegion: getComputedStyle(b).webkitAppRegion ?? getComputedStyle(b).getPropertyValue('-webkit-app-region') } })
  d.avatar = await page.evaluate(() => [...document.querySelectorAll('[data-slot=avatar], [data-slot=avatar-image], [data-slot=avatar-fallback], img[alt]')].slice(0, 8).map(a => ({ slot: a.getAttribute('data-slot'), tag: a.tagName, text: a.innerText?.trim().slice(0, 10), w: Math.round(a.getBoundingClientRect().width), h: Math.round(a.getBoundingClientRect().height), src: a.getAttribute('src')?.slice(0, 80), complete: a.tagName === 'IMG' ? a.complete && a.naturalWidth > 0 : undefined })))
  d.railShot = await shot('rail-home')
  log('desktop', JSON.stringify(d).slice(0, 3000))
  save()
}

async function railNav() {
  ctx = 'rail'
  await goto(APP)
  const r = results.railNav = []
  const nav = page.locator('[role=navigation]').filter({ has: page.locator('button') }).first()
  const names = await nav.locator('button').allInnerTexts()
  for (const n of names.map(x => x.trim()).filter(Boolean)) {
    const since = events.length
    await nav.locator('button', { hasText: n }).first().click().catch(e => r.push({ n, error: String(e).slice(0, 120) }))
    await sleep(1500)
    r.push({ n, url: page.url().replace(ORIGIN, ''), current: await nav.locator('button[aria-current=page]').innerText().catch(() => null), errors: take(since), shot: await shot(`rail-${n}`) })
  }
  log('rail', r.map(x => `${x.n}->${x.url} cur=${x.current} err=${x.errors?.length}`))
  save()
}

async function signOutAndDesktopAuth() {
  const a = results.auth ??= {}
  ctx = 'auth'
  // Sign out via the rail's account menu.
  await goto(APP)
  const menuBtn = page.locator('[role=navigation] [data-slot=dropdown-menu-trigger], [role=navigation] button[aria-haspopup=menu]').last()
  await menuBtn.click().catch(e => { a.menuErr = String(e).slice(0, 100) })
  await sleep(700)
  a.menuItems = await page.locator('[role=menuitem]').allInnerTexts().catch(() => [])
  a.menuShot = await shot('account-menu')
  const so = page.locator('[role=menuitem]').filter({ hasText: /退出|登出|Sign out/ }).first()
  if (await so.count()) { await so.click(); await page.waitForURL(/sign-in/, { timeout: 30_000 }).catch(() => {}); await sleep(1500) }
  a.afterSignOut = page.url()
  // Desktop OAuth button: must not navigate the window; it opens the system browser.
  await goto(`${APP}/sign-in`)
  await clearOpened(app)
  const since = events.length
  await page.getByRole('button', { name: /Google/ }).click()
  await sleep(2500)
  a.googleClick = { url: page.url(), opened: await opened(app), notice: await page.locator('[role=status], [role=alert], p').allInnerTexts().then(t => t.filter(x => /浏览器|browser/i.test(x))).catch(() => []), errors: take(since), shot: await shot('google-click') }
  const ext = a.googleClick.opened[0]
  if (!ext) { save(); return }
  // Finish the handoff in a separate "system browser": email sign-in on the desktop sign-in URL.
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch())
  const bctx = await browser.newContext({ locale: 'zh-CN' })
  const bp = await bctx.newPage()
  await bp.goto(ext, { waitUntil: 'domcontentloaded' })
  await sleep(1500)
  a.systemBrowserPage = { url: bp.url().replace(/desktop_state=[^&]+/, 'desktop_state=…'), text: (await bp.locator('body').innerText()).slice(0, 300) }
  await bp.screenshot({ path: `${OUT}/shots/sysbrowser-signin.png` })
  await bp.locator('input[name="email"]').fill(acct.email)
  await bp.locator('input[name="password"]').fill(acct.password)
  const loopbackSeen = []
  bp.on('request', r => { if (r.url().startsWith('http://127.0.0.1')) loopbackSeen.push(r.url().replace(/code=[^&]+/, 'code=…').replace(/state=[^&]+/, 'state=…')) })
  await bp.locator('form button[type="submit"]').click()
  await sleep(6000)
  a.systemBrowserEnd = { url: bp.url().replace(/(code|state)=[^&]+/g, '$1=…'), text: (await bp.locator('body').innerText().catch(() => '')).slice(0, 200), loopbackSeen }
  await bp.screenshot({ path: `${OUT}/shots/sysbrowser-end.png` })
  await browser.close()
  // Electron should have loaded /api/desktop/finish and then be signed in.
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
  await sleep(4000)
  a.electronAfter = { url: page.url().replace(/#.*/, '#…'), session: await page.evaluate(() => fetch('/mikka/api/auth/get-session').then(r => r.json()).then(j => ({ email: j?.user?.email ?? null })).catch(e => String(e))), shot: await shot('after-desktop-handoff'), errors: take(since) }
  a.sameAccount = a.electronAfter.session?.email === acct.email
  log('auth', JSON.stringify(a).slice(0, 2500))
  save()
}

const SETTINGS = ['account', 'security', 'preferences', 'notifications', 'memory', 'connections', 'models', 'logins', 'privacy', 'activity', 'computers', 'general', 'permissions']
try {
  if (phase === 'signup' || phase === 'all') await signUpInApp()
  if (phase === 'desktop' || phase === 'all') await desktopChecks()
  if (phase === 'rail' || phase === 'all') await railNav()
  if (phase === 'pages' || phase === 'all') {
    await crawl('主页', APP)
    for (const s of ['suggestions', 'projects', 'plugins', 'artifacts']) await crawl(`section-${s}`, `${APP}?section=${s}`, { cap: 35 })
    for (const s of SETTINGS) await crawl(`设置-${s}`, `${APP}/settings?section=${s}`, { cap: 35 })
    await crawl('设置-members', `${APP}/settings/members`, { cap: 30 })
    await crawl('设置-teams', `${APP}/settings/teams`, { cap: 30 })
    for (const p of ['dashboard', 'device', 'workspaces/new']) await crawl(p, `${APP}/${p}`, { cap: 25 })
  }
  if (phase === 'auth' || phase === 'all') await signOutAndDesktopAuth()
} catch (e) {
  log('FATAL', String(e.stack ?? e).slice(0, 800)); results.fatal = String(e).slice(0, 500); await shot('fatal')
} finally {
  results.mainLogs = mainLogs.filter(([, l]) => !/CreatePlatformSocket|ssl_client_socket_impl/.test(l)).slice(0, 200)
  results.mainLogsNetworkNoise = mainLogs.filter(([, l]) => /CreatePlatformSocket|ssl_client_socket_impl/.test(l)).length
  results.events = events
  save()
  await app.close().catch(() => {})
}
