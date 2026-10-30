// Throwaway interaction crawler for the Mikka QA sweep. Lives outside the repo.
// Usage (cwd = repo): PASS=default node ~/qa/crawl.mjs
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
const { Pool } = (await import('/home/user/Mikka/node_modules/pg/lib/index.js')).default
import { acquireTestAccounts } from '/home/user/Mikka/scripts/test-accounts/session.mjs'
import { loadEnvironment } from '/home/user/Mikka/scripts/test-accounts/environment.mjs'

const require = createRequire('/home/user/Mikka/package.json')
const { chromium } = require('@playwright/test')

const PASS = process.env.PASS ?? 'default'
const OUT = `/root/qa/out-${PASS}`
const SHOTS = `${OUT}/shots`
mkdirSync(SHOTS, { recursive: true })
const ORIGIN = 'http://localhost:3100'
const app = p => `/mikka${p === '/' ? '' : p}`
const log = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(s); appendFileSync(`${OUT}/log.txt`, s + '\n') }
const results = []
const SKIP = /删除|移除|退出登录|登出|注销|撤销|离开|解散|转移|Sign out|Log out|Delete|Remove|Revoke|付款|支付|订阅|升级|购买|Checkout|Stripe|Google|GitHub|Slack|Telegram|Linear|Gmail|Outlook|Notion|连接|授权|Connect|导出|下载|发送验证|重置|停用|暂停成员|关闭账户|清空|清除|Reset|Upgrade|Billing|吊销|作废|永久|Download|登录 Mikka|使用 .* 登录|^English$/

const db = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 })
const sid = s => createHash('sha1').update(s).digest('hex').slice(0, 8)

// ---------- seeding (isolated _e2e DB only) ----------
async function seedOwner(userId) {
  const issueIds = []
  for (const [title, status] of [['QA 扫描任务 A', 'todo'], ['QA 扫描任务 B', 'doing'], ['QA 扫描任务 C', 'done']]) {
    const { rows: [{ number }] } = await db.query(`SELECT COALESCE(MAX((content->'attrs'->'mikka'->>'number')::int), 0) + 1 AS number FROM issues WHERE "userId" = $1`, [userId])
    const id = randomUUID()
    const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'QA 描述正文' }] }], attrs: { mikka: { number } } }
    await db.query('INSERT INTO issues (id, "userId", title, content, status, priority) VALUES ($1,$2,$3,$4,$5,$6)', [id, userId, title, content, status, 'normal'])
    await db.query('INSERT INTO issue_versions (id, "issueId", "userId", revision, title, content, status, priority) VALUES ($1,$2,$3,1,$4,$5,$6,$7)', [randomUUID(), id, userId, title, content, status, 'normal'])
    issueIds.push(id)
  }
  const sug = randomUUID()
  await db.query('INSERT INTO suggestions (id, "userId", source, "externalId", action, title, shown, "decidedBy", "actionTitle", "occurredAt") VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,now())', [sug, userId, 'gmail', `qa-${sug}`, 'reply', 'QA 建议：回复邮件', 'rule', null])
  // A dispatched thread, the way thread-cards.spec seeds it.
  const agentId = randomUUID(), runId = randomUUID()
  await db.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1,$2,$3,$4)', [agentId, userId, 'codex', 'QA Frontend'])
  await db.query('INSERT INTO agent_runs (id, "userId", "issueId", "agentId", status, prompt) VALUES ($1,$2,$3,$4,$5,$6)', [runId, userId, issueIds[0], agentId, 'running', 'QA 线程：测一下首页\n先测量。'])
  const artifactId = randomUUID()
  await db.query('INSERT INTO artifacts (id, "userId", kind, title, "runId", "issueId") VALUES ($1,$2,$3,$4,$5,$6)', [artifactId, userId, 'markdown', 'QA 产物', runId, issueIds[0]])
  await db.query('INSERT INTO artifact_versions (id, "artifactId", version, "storageKey", "inlineContent", sha256, size, "authorName") VALUES ($1,$2,1,$3,$4,$5,$6,$7)', [randomUUID(), artifactId, `e2e/${artifactId}.md`, '# QA 产物\n\n3.8s', 'e2e', 18, 'QA Frontend'])
  let seq = 0
  for (const chunk of [{ type: 'text-delta', id: 't1', delta: '首页加载 3.8s。' }]) await db.query('INSERT INTO run_chunks (id, "runId", seq, chunk) VALUES ($1,$2,$3,$4)', [randomUUID(), runId, ++seq, JSON.stringify(chunk)])
  const msgs = [
    { role: 'user', content: '首页很慢' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'dispatch_run', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'dispatch_run', output: { type: 'json', value: { runId, status: 'queued' } } }] },
    { role: 'assistant', content: [{ type: 'text', text: 'QA Frontend 已接手。' }] },
  ]
  const { rows: [{ p }] } = await db.query('SELECT COALESCE(MAX(position),0) p FROM coordinator_messages WHERE "userId"=$1', [userId])
  for (const [i, m] of msgs.entries()) await db.query('INSERT INTO coordinator_messages (id, "userId", position, message) VALUES ($1,$2,$3,$4)', [randomUUID(), userId, Number(p) + i + 1, JSON.stringify(m)])
  return { issueIds, runId, artifactId }
}

// ---------- in-page helpers ----------
const SCAN = `(() => {
  const sel = 'button, a[href], [role=button], [role=switch], [role=checkbox], [role=radio], [role=combobox], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=link], input:not([type=hidden]), textarea, select, [contenteditable=true]'
  const roleOf = el => {
    const r = el.getAttribute('role'); if (r) return r
    const t = el.tagName.toLowerCase()
    if (t === 'a') return 'link'; if (t === 'button') return 'button'; if (t === 'select') return 'combobox'; if (t === 'textarea') return 'textbox'
    if (t === 'input') { const ty = (el.type || 'text'); return ty === 'checkbox' ? 'checkbox' : ty === 'radio' ? 'radio' : ['button','submit','reset'].includes(ty) ? 'button' : ty === 'file' ? 'file' : 'textbox' }
    if (el.isContentEditable) return 'textbox'
    return t
  }
  const nameOf = el => {
    const lb = el.getAttribute('aria-labelledby')
    let n = el.getAttribute('aria-label') || (lb && lb.split(' ').map(id => document.getElementById(id)?.innerText || '').join(' ')) || (el.labels && el.labels[0]?.innerText) || el.getAttribute('title') || (el.innerText || '').trim() || el.getAttribute('placeholder') || el.getAttribute('name') || ''
    return n.replace(/\\s+/g, ' ').trim().slice(0, 50)
  }
  const out = []; const seen = {}
  for (const el of document.querySelectorAll(sel)) {
    if (el.closest('[data-qa-ignore]')) continue
    if (el.parentElement && el.parentElement.closest(sel) && !['INPUT','TEXTAREA','SELECT'].includes(el.tagName) && el.parentElement.closest(sel).tagName !== 'LABEL') continue
    const rect = el.getBoundingClientRect()
    const visible = rect.width > 0 && rect.height > 0 && el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) !== false
    if (!visible) continue
    const role = roleOf(el), name = nameOf(el)
    const base = role + '|' + name
    const k = seen[base] = (seen[base] ?? -1) + 1
    const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled')
    const href = el.getAttribute('href'), target = el.getAttribute('target')
    out.push({ key: base + '#' + k, role, name, disabled, href, target, tag: el.tagName.toLowerCase(), type: el.type || '', el })
  }
  return out
})()`
const listElements = page => page.evaluate(`${SCAN}.map(({el, ...rest}) => rest)`)
const tagTarget = (page, key) => page.evaluate(`(() => { document.querySelectorAll('[data-qa-target]').forEach(e => e.removeAttribute('data-qa-target')); const hit = ${SCAN}.find(x => x.key === ${JSON.stringify(key)}); if (!hit) return false; hit.el.setAttribute('data-qa-target', '1'); return true })()`)
const snapshot = (page) => page.evaluate(() => {
  const t = document.querySelector('[data-qa-target]')
  const h = document.body.innerHTML.replace(/data-qa-target="1"/g, '')
  let hash = 0; for (let i = 0; i < h.length; i += 3) hash = (hash * 31 + h.charCodeAt(i)) | 0
  return {
    url: location.pathname + location.search + location.hash,
    hash, len: h.length,
    overlays: document.querySelectorAll('[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper],[data-sonner-toast],[role=tooltip]').length,
    target: t ? [t.getAttribute('aria-expanded'), t.getAttribute('aria-pressed'), t.getAttribute('aria-checked'), t.getAttribute('aria-selected'), t.getAttribute('data-state'), t.value, t.checked].join('|') : 'gone',
    active: document.activeElement === t,
    toasts: [...document.querySelectorAll('[data-sonner-toast]')].map(x => x.innerText.slice(0, 120)),
    alerts: [...document.querySelectorAll('[role=alert]')].map(x => x.innerText.slice(0, 120)).filter(Boolean),
  }
})

// ---------- page instrumentation ----------
function instrument(page, bucketRef) {
  page.on('pageerror', e => bucketRef.cur.push({ kind: 'pageerror', msg: String(e.message).slice(0, 400) }))
  page.on('console', m => { if (m.type() === 'error') bucketRef.cur.push({ kind: 'console', msg: m.text().slice(0, 400) }) })
  page.on('response', r => {
    const u = new URL(r.url()); if (u.origin !== ORIGIN) return
    const s = r.status()
    if (s >= 500 || (s >= 400 && s !== 401)) bucketRef.cur.push({ kind: 'http', msg: `${s} ${r.request().method()} ${u.pathname}${u.search.slice(0, 80)}` })
    if (s === 401) bucketRef.cur.push({ kind: 'http401', msg: `${s} ${r.request().method()} ${u.pathname}` })
  })
  page.on('requestfailed', r => { const f = r.failure()?.errorText ?? ''; if (!/ERR_ABORTED|NS_BINDING_ABORTED|ERR_BLOCKED/.test(f) && new URL(r.url()).origin === ORIGIN) bucketRef.cur.push({ kind: 'reqfail', msg: `${f} ${new URL(r.url()).pathname}` }) })
}

const settle = async (page, ms = 700) => { await page.waitForTimeout(ms); await page.waitForLoadState('domcontentloaded').catch(() => {}) }

async function closeOverlays(page) {
  for (let i = 0; i < 3; i++) {
    const n = await page.locator('[role=dialog],[role=alertdialog],[role=menu],[role=listbox]').count().catch(() => 0)
    if (!n) return
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(250)
  }
}

let shotN = 0
async function shot(page, label) {
  const f = `${PASS}-${String(++shotN).padStart(3, '0')}-${label.replace(/[^\w一-龥-]+/g, '_').slice(0, 50)}.png`
  await page.screenshot({ path: `${SHOTS}/${f}` }).catch(() => {})
  return f
}

const globalDone = new Map() // role|name -> verdict, for shell elements repeated on every route

async function crawlRoute(page, bucketRef, { profile, route, label, max = 90, setup }) {
  const pageRes = { profile, route, label, load: [], items: [] }
  results.push(pageRes)
  bucketRef.cur = pageRes.load
  const go = async () => {
    bucketRef.cur = pageRes.load
    await page.goto(ORIGIN + app(route), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => pageRes.load.push({ kind: 'timeout', msg: String(e.message).slice(0, 200) }))
    await settle(page, 1800)
    if (setup) await setup(page).catch(e => pageRes.load.push({ kind: 'setup', msg: String(e.message).slice(0, 200) }))
  }
  await go()
  pageRes.finalUrl = new URL(page.url()).pathname + new URL(page.url()).search
  pageRes.loadShot = await shot(page, `${profile}-${label}-load`)
  let elements = await listElements(page).catch(() => [])
  pageRes.elementCount = elements.length
  log(`[${profile}] ${label} ${route} -> ${pageRes.finalUrl} elements=${elements.length} loadErrors=${pageRes.load.length}`)
  let n = 0
  for (const el of elements) {
    if (n >= max) { pageRes.truncated = elements.length - n; break }
    const gkey = `${profile}|${el.role}|${el.name}`
    const item = { key: el.key, role: el.role, name: el.name, errors: [] }
    if (el.role === 'file') { item.verdict = 'skip'; item.note = '文件选择器'; pageRes.items.push(item); continue }
    if (SKIP.test(el.name)) { item.verdict = 'skip-destructive'; pageRes.items.push(item); continue }
    if (el.disabled) { item.verdict = 'disabled'; pageRes.items.push(item); continue }
    if (el.role === 'link' && el.href && (/^https?:/.test(el.href) && !el.href.startsWith(ORIGIN) || el.target === '_blank' || /^mailto:|^tel:/.test(el.href))) { item.verdict = 'external-link'; item.note = el.href.slice(0, 120); pageRes.items.push(item); continue }
    if (globalDone.has(gkey) && globalDone.get(gkey) === 'ok') { item.verdict = 'dup'; pageRes.items.push(item); continue }
    n++
    bucketRef.cur = item.errors
    try {
      if (!(await tagTarget(page, el.key))) { await go(); if (!(await tagTarget(page, el.key))) { item.verdict = 'vanished'; pageRes.items.push(item); continue } }
      const target = page.locator('[data-qa-target]').first()
      const before = await snapshot(page)
      let popup
      const popupP = page.context().waitForEvent('page', { timeout: 1500 }).then(p => (popup = p)).catch(() => {})
      if (el.role === 'textbox') {
        await target.click({ timeout: 4000 })
        await page.keyboard.type(el.type === 'email' ? 'qa@example.com' : el.type === 'number' ? '3' : 'QA测试', { delay: 5 })
      } else if (el.tag === 'select') {
        const opts = await target.evaluate(s => [...s.options].map(o => o.value))
        if (opts.length > 1) await target.selectOption(opts[1])
      } else {
        await target.click({ timeout: 4000 })
      }
      await settle(page, 900)
      await popupP
      const after = await snapshot(page)
      item.changed = before.url !== after.url || before.hash !== after.hash || before.overlays !== after.overlays || before.target !== after.target || !!popup
      item.urlAfter = before.url !== after.url ? after.url : undefined
      item.overlay = after.overlays > before.overlays
      item.toasts = after.toasts.filter(t => !before.toasts.includes(t))
      item.alerts = after.alerts.filter(t => !before.alerts.includes(t))
      if (popup) { item.popup = popup.url().slice(0, 120); await popup.close().catch(() => {}) }
      const hard = item.errors.filter(e => e.kind !== 'http401')
      item.verdict = hard.length ? 'error' : item.changed ? 'ok' : 'noop'
      if (item.verdict !== 'ok') item.shot = await shot(page, `${profile}-${label}-${el.role}-${el.name || 'unnamed'}`)
      if (after.url !== before.url) { await go() } else { await closeOverlays(page) }
    } catch (e) {
      item.verdict = 'timeout'; item.note = String(e.message).split('\n')[0].slice(0, 200)
      item.shot = await shot(page, `${profile}-${label}-timeout-${el.name || el.role}`)
      await closeOverlays(page); await go()
    }
    globalDone.set(gkey, item.verdict)
    pageRes.items.push(item)
    if (item.verdict !== 'ok') log(`   ${item.verdict} ${el.role} "${el.name}" ${item.errors.map(e => e.kind + ':' + e.msg).join(' || ').slice(0, 300)} ${item.note ?? ''}`)
  }
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1))
}

async function newCtx(browser, statePath, opts = {}) {
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  const ctx = await browser.newContext({ baseURL: ORIGIN, locale: 'zh-CN', storageState: state, serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, ...opts })
  // Keep the run offline from the outside world.
  await ctx.route(url => new URL(url).origin !== ORIGIN && !url.startsWith('data:') && !url.startsWith('blob:'), r => r.abort('blockedbyclient'))
  const page = await ctx.newPage()
  const bucketRef = { cur: [] }
  instrument(page, bucketRef)
  return { ctx, page, bucketRef }
}

// ---------- main ----------
const environment = await loadEnvironment()
const scope = await acquireTestAccounts({ environment, runId: `qa-sweep-${PASS}-${Date.now()}`, workerId: 'qa-crawler', requestId: randomUUID(), ttlMs: 120_000 })
log('accounts acquired', { owner: scope.owner.userId, peer: scope.peer.userId })
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
let outcome = 'clean'
try {
  const seeded = await seedOwner(scope.owner.userId)
  writeFileSync(`${OUT}/seeded.json`, JSON.stringify(seeded))
  const owner = await newCtx(browser, scope.owner.storageStatePath)
  const { page } = owner

  // Join the peer to the owner's workspace through the real invite UI.
  const { rows: [{ email: peerEmail }] } = await db.query('SELECT email FROM "user" WHERE id=$1', [scope.peer.userId])
  let inviteNote = ''
  try {
    owner.bucketRef.cur = []
    await page.goto(ORIGIN + app('/settings/members?invite=1'))
    const dialog = page.getByRole('dialog', { name: '邀请成员', exact: true })
    await dialog.waitFor({ timeout: 20000 })
    await dialog.getByLabel('邮箱地址', { exact: true }).fill(peerEmail)
    await dialog.getByRole('button', { name: '创建邀请链接', exact: true }).click()
    await page.waitForTimeout(2500)
    const link = await dialog.evaluate(d => { const txt = d.innerText + ' ' + [...d.querySelectorAll('input,textarea')].map(i => i.value).join(' '); return (txt.match(/https?:\/\/\S*\/invite\/[\w-]+/) || [])[0] })
    inviteNote = link ? 'invite link created' : 'no link: ' + (await dialog.innerText()).slice(0, 200)
    await shot(page, 'setup-invite-dialog')
    if (link) {
      const peer0 = await newCtx(browser, scope.peer.storageStatePath)
      await peer0.page.goto(link.replace(/^https?:\/\/[^/]+/, ORIGIN))
      await peer0.page.waitForTimeout(2500)
      await shot(peer0.page, 'setup-invite-peer')
      const accept = peer0.page.getByRole('button', { name: /接受|加入/ }).first()
      if (await accept.count()) { await accept.click(); await peer0.page.waitForTimeout(3000); inviteNote += '; peer accepted via UI' }
      inviteNote += ` errors=${JSON.stringify(peer0.bucketRef.cur)}`
      await peer0.ctx.close()
    }
  } catch (e) { inviteNote += ' invite failed: ' + e.message.split('\n')[0] }
  const { rows: membership } = await db.query('SELECT m."workspaceId", m.role FROM mikka_workspace_members m JOIN mikka_workspace_members o ON o."workspaceId"=m."workspaceId" AND o."userId"=$1 WHERE m."userId"=$2', [scope.owner.userId, scope.peer.userId])
  inviteNote += ` membership=${JSON.stringify(membership)} setupErrors=${JSON.stringify(owner.bucketRef.cur).slice(0, 600)}`
  log('invite:', inviteNote)
  writeFileSync(`${OUT}/invite.txt`, inviteNote)

  const issue = seeded.issueIds[0]
  const routes = [
    ['home-chats', '/'],
    ['suggestions', '/?section=suggestions'],
    ['board', '/?section=projects'],
    ['threads-agent', '/?section=agent'],
    ['plugins', '/?section=plugins'],
    ['artifacts', '/?section=artifacts'],
    ['issue-detail', `/?issue=${issue}`],
    ...['account', 'security', 'preferences', 'notifications', 'memory', 'connections', 'models', 'logins', 'privacy', 'activity', 'computers', 'general', 'permissions'].map(s => [`settings-${s}`, `/settings?section=${s}`]),
    ['settings-members', '/settings/members'],
    ['settings-teams', '/settings/teams'],
    ['settings-hidden-billing', '/settings?section=billing'],
    ['workspaces-new', '/workspaces/new'],
    ['device', '/device'],
    ['dashboard', '/dashboard'],
    ['acceptance', '/acceptance'],
    ['preview-credential-login', '/preview/credential-login'],
    ['preview-subagent-login', '/preview/subagent-login'],
    ['not-found', '/does-not-exist'],
  ]
  for (const [label, route] of routes) await crawlRoute(page, owner.bucketRef, { profile: 'owner', route, label })

  await crawlRoute(page, owner.bucketRef, { profile: 'owner', route: '/', label: 'issue-board', max: 60, setup: async p => { await p.getByRole('button', { name: '看板', exact: true }).click(); await p.waitForTimeout(1500) } })
  await crawlRoute(page, owner.bucketRef, { profile: 'owner', route: '/', label: 'issue-list', max: 40, setup: async p => { await p.getByRole('button', { name: '看板', exact: true }).click(); await p.waitForTimeout(1200); await p.getByRole('radio', { name: '列表视图' }).or(p.getByRole('button', { name: '列表视图' })).first().click(); await p.waitForTimeout(1200) } })
  // Thread view: open the seeded thread from the issue / chat card.
  await crawlRoute(page, owner.bucketRef, { profile: 'owner', route: '/', label: 'thread-view', max: 60, setup: async p => {
    const card = p.getByRole('button', { name: /打开线程 QA 线程/ }).first()
    await card.click({ timeout: 8000 }); await p.waitForTimeout(1500)
  } })
  // Global search (⌘K)
  await crawlRoute(page, owner.bucketRef, { profile: 'owner', route: '/', label: 'search-palette', max: 30, setup: async p => {
    await p.keyboard.press('Control+k'); await p.waitForTimeout(800)
    await p.keyboard.type('QA'); await p.waitForTimeout(1500)
  } })
  await owner.ctx.close()

  // Peer (workspace member)
  const peer = await newCtx(browser, scope.peer.storageStatePath)
  for (const [label, route] of [['home-chats', '/'], ['board', '/?section=projects'], ['issue-detail-owner-issue', `/?issue=${issue}`], ['settings-general', '/settings?section=general'], ['settings-members', '/settings/members'], ['settings-teams', '/settings/teams'], ['settings-permissions-hidden', '/settings?section=permissions'], ['settings-preferences', '/settings?section=preferences']])
    await crawlRoute(peer.page, peer.bucketRef, { profile: 'peer', route, label, max: 50 })
  await peer.ctx.close()

  // Mobile + dark
  const mobile = await newCtx(browser, scope.owner.storageStatePath, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  for (const [label, route] of [['home-chats', '/'], ['board', '/?section=projects'], ['issue-detail', `/?issue=${issue}`], ['settings', '/settings?section=preferences']])
    await crawlRoute(mobile.page, mobile.bucketRef, { profile: 'mobile', route, label, max: 35 })
  await mobile.ctx.close()
  const dark = await newCtx(browser, scope.owner.storageStatePath, { colorScheme: 'dark' })
  for (const [label, route] of [['home-chats', '/'], ['board', '/?section=projects'], ['issue-detail', `/?issue=${issue}`], ['settings', '/settings?section=preferences']])
    await crawlRoute(dark.page, dark.bucketRef, { profile: 'dark', route, label, max: 0 })
  await dark.ctx.close()

  // Anonymous auth pages
  const anon = await browser.newContext({ baseURL: ORIGIN, locale: 'zh-CN' })
  const ap = await anon.newPage(); const abr = { cur: [] }; instrument(ap, abr)
  for (const [label, route] of [['sign-in', '/sign-in'], ['sign-up', '/sign-up'], ['forgot-password', '/forgot-password'], ['reset-password', '/reset-password'], ['verify-email', '/verify-email'], ['anon-root', '/'], ['invite-bad-token', '/invite/not-a-token']])
    await crawlRoute(ap, abr, { profile: 'anon', route, label, max: 25 })
  await anon.close()
} catch (e) {
  outcome = 'dirty'; log('FATAL', e.stack)
} finally {
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1))
  await browser.close()
  await scope.release({ outcome }).catch(e => log('release failed', e.code ?? e.message))
  await db.end()
  log('done')
}
