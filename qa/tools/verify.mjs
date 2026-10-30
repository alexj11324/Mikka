// Targeted re-verification of crawler candidates + explicit flows. Outside the repo.
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { acquireTestAccounts } from '/home/user/Mikka/scripts/test-accounts/session.mjs'
import { loadEnvironment } from '/home/user/Mikka/scripts/test-accounts/environment.mjs'
const { Pool } = (await import('/home/user/Mikka/node_modules/pg/lib/index.js')).default
const require = createRequire('/home/user/Mikka/package.json')
const { chromium } = require('@playwright/test')

const PASS = process.env.PASS ?? 'default'
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null
const OUT = `/root/qa/verify-${PASS}`
mkdirSync(`${OUT}/shots`, { recursive: true })
const ORIGIN = 'http://localhost:3100'
const app = p => ORIGIN + `/mikka${p === '/' ? '' : p}`
const log = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(s); appendFileSync(`${OUT}/log.txt`, s + '\n') }
const db = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 })
const steps = []
let n = 0
const shot = async (page, label) => { const f = `${PASS}-v${String(++n).padStart(3, '0')}-${label.replace(/[^\w一-龥-]+/g, '_').slice(0, 50)}.png`; await page.screenshot({ path: `${OUT}/shots/${f}` }).catch(() => {}); return f }

function instrument(page, ref) {
  page.on('pageerror', e => ref.cur.push(`pageerror: ${String(e.message).slice(0, 300)}`))
  page.on('console', m => { if (m.type() === 'error') ref.cur.push(`console: ${m.text().slice(0, 300)}`) })
  page.on('response', r => { const u = new URL(r.url()); if (u.origin === ORIGIN && r.status() >= 400) ref.cur.push(`http ${r.status()} ${r.request().method()} ${u.pathname}${u.search.slice(0, 60)}`) })
  page.on('requestfailed', r => { const f = r.failure()?.errorText ?? ''; if (!/ABORTED|BLOCKED/.test(f) && new URL(r.url()).origin === ORIGIN) ref.cur.push(`reqfail ${f} ${new URL(r.url()).pathname}`) })
}
async function ctxFor(browser, statePath, opts = {}) {
  const ctx = await browser.newContext({ baseURL: ORIGIN, locale: 'zh-CN', storageState: JSON.parse(readFileSync(statePath, 'utf8')), serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, ...opts })
  await ctx.route(url => new URL(url).origin !== ORIGIN && !/^(data|blob):/.test(url), r => r.abort('blockedbyclient'))
  const page = await ctx.newPage(); const ref = { cur: [] }; instrument(page, ref)
  return { ctx, page, ref }
}
async function step(name, who, fn) {
  if (ONLY && !ONLY.test(name)) return
  const rec = { name, errors: [], notes: [] }
  who.ref.cur = rec.errors
  try { await fn(who.page, rec) ; rec.result = rec.result ?? 'pass' }
  catch (e) { rec.result = 'fail'; rec.notes.push(String(e.message).split('\n').slice(0, 3).join(' ').slice(0, 400)) }
  rec.shot = await shot(who.page, name)
  steps.push(rec)
  log(`${rec.result.toUpperCase()} ${name} :: ${rec.notes.join(' | ')} ${rec.errors.length ? ' ERR=' + JSON.stringify(rec.errors) : ''}`)
  await who.page.keyboard.press('Escape').catch(() => {})
}
const settle = p => p.waitForTimeout(1200)

async function seed(userId) {
  const ids = []
  for (const [title, status] of [['QA 任务 A', 'todo'], ['QA 任务 B', 'doing'], ['QA 任务 C', 'done']]) {
    const { rows: [{ number }] } = await db.query(`SELECT COALESCE(MAX((content->'attrs'->'mikka'->>'number')::int), 0) + 1 AS number FROM issues WHERE "userId" = $1`, [userId])
    const id = randomUUID(); const content = { type: 'doc', content: [{ type: 'paragraph' }], attrs: { mikka: { number } } }
    await db.query('INSERT INTO issues (id, "userId", title, content, status, priority) VALUES ($1,$2,$3,$4,$5,$6)', [id, userId, title, content, status, 'normal'])
    await db.query('INSERT INTO issue_versions (id, "issueId", "userId", revision, title, content, status, priority) VALUES ($1,$2,$3,1,$4,$5,$6,$7)', [randomUUID(), id, userId, title, content, status, 'normal'])
    ids.push(id)
  }
  const s = randomUUID()
  await db.query('INSERT INTO suggestions (id, "userId", source, "externalId", action, title, shown, "decidedBy", "actionTitle", "occurredAt") VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,now())', [s, userId, 'gmail', `qa-${s}`, 'reply', 'QA 建议：回复邮件', 'rule', null])
  const agentId = randomUUID(), runId = randomUUID()
  await db.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1,$2,$3,$4)', [agentId, userId, 'codex', 'QA Frontend'])
  await db.query('INSERT INTO agent_runs (id, "userId", "issueId", "agentId", status, prompt) VALUES ($1,$2,$3,$4,$5,$6)', [runId, userId, ids[0], agentId, 'running', 'QA 线程：测一下首页\n先测量。'])
  const artifactId = randomUUID()
  await db.query('INSERT INTO artifacts (id, "userId", kind, title, "runId", "issueId") VALUES ($1,$2,$3,$4,$5,$6)', [artifactId, userId, 'markdown', 'QA 产物', runId, ids[0]])
  await db.query('INSERT INTO artifact_versions (id, "artifactId", version, "storageKey", "inlineContent", sha256, size, "authorName") VALUES ($1,$2,1,$3,$4,$5,$6,$7)', [randomUUID(), artifactId, `e2e/${artifactId}.md`, '# QA 产物\n\n3.8s', 'e2e', 18, 'QA Frontend'])
  await db.query('INSERT INTO run_chunks (id, "runId", seq, chunk) VALUES ($1,$2,1,$3)', [randomUUID(), runId, JSON.stringify({ type: 'text-delta', id: 't1', delta: '首页加载 3.8s。' })])
  const msgs = [{ role: 'user', content: '首页很慢' }, { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'dispatch_run', input: {} }] }, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'dispatch_run', output: { type: 'json', value: { runId, status: 'queued' } } }] }, { role: 'assistant', content: [{ type: 'text', text: 'QA Frontend 已接手。' }] }]
  for (const [i, m] of msgs.entries()) await db.query('INSERT INTO coordinator_messages (id, "userId", position, message) VALUES ($1,$2,$3,$4)', [randomUUID(), userId, i + 1, JSON.stringify(m)])
  return { ids, runId, artifactId }
}

const environment = await loadEnvironment()
const scope = await acquireTestAccounts({ environment, runId: `qa-verify-${PASS}-${Date.now()}`, workerId: 'qa-verify', requestId: randomUUID(), ttlMs: 120_000 })
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
try {
  const seeded = await seed(scope.owner.userId)
  const O = await ctxFor(browser, scope.owner.storageStatePath)
  const { rows: [{ email: peerEmail }] } = await db.query('SELECT email FROM "user" WHERE id=$1', [scope.peer.userId])
  const P = await ctxFor(browser, scope.peer.storageStatePath)

  await step('invite-peer-via-ui', O, async (page, rec) => {
    await page.goto(app('/settings/members?invite=1'))
    const d = page.getByRole('dialog', { name: '邀请成员', exact: true }); await d.waitFor()
    await d.getByLabel('邮箱地址', { exact: true }).fill(peerEmail)
    await d.getByRole('button', { name: '创建邀请链接', exact: true }).click(); await page.waitForTimeout(2500)
    const link = await d.evaluate(x => { const t = x.innerText + ' ' + [...x.querySelectorAll('input,textarea')].map(i => i.value).join(' '); return (t.match(/https?:\/\/\S*\/invite\/[\w-]+/) || [])[0] })
    if (!link) throw new Error('no invite link')
    await P.page.goto(link.replace(/^https?:\/\/[^/]+/, ORIGIN)); await settle(P.page)
    await P.page.getByRole('button', { name: /接受|加入/ }).first().click(); await P.page.waitForTimeout(3000)
    rec.notes.push('peer url after accept: ' + P.page.url())
  })

  await step('home-new-bot-dialog', O, async (page, rec) => {
    await page.goto(app('/')); await settle(page)
    const b = page.getByRole('button', { name: '新建 Bot', exact: true })
    rec.notes.push(`新建 Bot count=${await b.count()} visible=${await b.first().isVisible()}`)
    await b.first().click({ timeout: 5000 }); await settle(page)
    const dlg = page.getByRole('dialog')
    rec.notes.push(`dialogs=${await dlg.count()} text=${(await dlg.first().innerText().catch(() => '')).slice(0, 150).replace(/\n/g, ' / ')}`)
  })
  await step('home-new-bot-create', O, async (page, rec) => {
    await page.goto(app('/')); await settle(page)
    await page.getByRole('button', { name: '新建 Bot', exact: true }).first().click(); await settle(page)
    const dlg = page.getByRole('dialog').first()
    await dlg.getByRole('textbox').first().fill('QA Bot')
    await dlg.getByRole('button', { name: '创建', exact: true }).click({ timeout: 5000 }); await page.waitForTimeout(3000)
    rec.notes.push(`dialog open=${await page.getByRole('dialog').count()} bot in list: ${await page.getByText('QA Bot').count()} url=${page.url().replace(ORIGIN, '')}`)
    rec.notes.push('db bots=' + JSON.stringify((await db.query(`SELECT name FROM bots WHERE "userId"=$1`, [scope.owner.userId]).catch(e => ({ rows: [e.message] }))).rows))
  })
  await step('board-rail', O, async (page, rec) => {
    await page.goto(app('/')); await settle(page)
    await page.getByRole('button', { name: '看板', exact: true }).click(); await settle(page)
    rec.notes.push('url=' + page.url().replace(ORIGIN, ''))
    rec.notes.push('buttons=' + JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('button')].filter(b => b.offsetParent).map(b => b.getAttribute('aria-label') || b.innerText).filter(Boolean).slice(9, 45))))
    await page.getByRole('button', { name: '新建任务' }).first().click(); await settle(page)
    await shot(page, 'board-new-task-opened')
    await page.keyboard.type('QA 新建任务'); await page.waitForTimeout(2500)
    rec.notes.push('after typing url=' + page.url().replace(ORIGIN, ''))
    rec.notes.push('created rows=' + (await db.query(`SELECT count(*) c FROM issues WHERE "userId"=$1 AND title LIKE 'QA 新建任务%'`, [scope.owner.userId])).rows[0].c)
    await page.reload(); await settle(page); rec.notes.push('after reload url=' + page.url().replace(ORIGIN, '') + ' boardVisible=' + await page.getByRole('button', { name: '新建任务' }).count())
  })
  await step('board-list-toggle', O, async (page, rec) => {
    await page.goto(app('/')); await settle(page)
    await page.getByRole('button', { name: '看板', exact: true }).click(); await settle(page)
    const list = page.getByRole('radio', { name: '列表视图' }).or(page.getByRole('button', { name: '列表视图' })).first()
    rec.notes.push('list toggle count=' + await list.count())
    if (await list.count()) { await list.click(); await settle(page); await shot(page, 'board-list-view'); rec.notes.push('rows QA=' + await page.getByText(/QA 任务/).count()) }
  })
  await step('composer-attach-filechooser', O, async (page, rec) => {
    await page.goto(app('/')); await settle(page)
    const fc = page.waitForEvent('filechooser', { timeout: 4000 }).then(() => true).catch(() => false)
    await page.getByRole('button', { name: '添加文件', exact: true }).first().click()
    rec.notes.push('filechooser opened=' + await fc)
  })
  await step('composer-send-message', O, async (page, rec) => {
    await page.goto(app('/')); await settle(page)
    const box = page.getByRole('textbox', { name: '给 Coordinator 发消息' })
    await box.fill('你好，QA 测试消息'); await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.waitForTimeout(8000)
    rec.notes.push('tail: ' + (await page.locator('main').last().innerText().catch(() => '')).slice(-300).replace(/\n/g, ' / '))
  })
  await step('thread-open-and-tabs', O, async (page, rec) => {
    await page.goto(app('/')); await settle(page)
    await page.getByRole('button', { name: /打开线程 QA 线程/ }).first().click(); await settle(page)
    rec.notes.push('url=' + page.url().replace(ORIGIN, ''))
    const tabs = await page.getByRole('tab').allInnerTexts(); rec.notes.push('tabs=' + JSON.stringify(tabs))
    for (const t of tabs) { const tb = page.getByRole('tab', { name: t, exact: true }).first(); if (await tb.isVisible().catch(() => false)) { await tb.click().catch(e => rec.notes.push(`tab ${t} click fail`)); await page.waitForTimeout(800); await shot(page, 'thread-tab-' + t) } }
    const btns = await page.locator('main button:visible, [role=complementary] button:visible').allInnerTexts().catch(() => []); rec.notes.push('buttons=' + JSON.stringify(btns.filter(Boolean).slice(0, 30)))
  })
  await step('thread-computer-tab', O, async (page, rec) => {
    const comp = page.getByRole('tab', { name: /电脑|Computer|计算机/ }).first()
    rec.notes.push('computer tab count=' + await comp.count())
    if (await comp.count()) { await comp.click(); await settle(page); rec.notes.push('panel: ' + (await page.locator('[role=tabpanel]:visible').first().innerText().catch(() => '')).slice(0, 200).replace(/\n/g, ' / ')) }
  })
  await step('thread-stop', O, async (page, rec) => {
    const stop = page.getByRole('button', { name: /停止/ }).first()
    rec.notes.push('stop count=' + await stop.count())
    if (await stop.count()) { await stop.click(); await page.waitForTimeout(2500); const c = page.getByRole('alertdialog'); if (await c.count()) { rec.notes.push('confirm: ' + (await c.innerText()).slice(0, 100)); await c.getByRole('button', { name: /停止|确定/ }).last().click(); await page.waitForTimeout(2500) } rec.notes.push('status: ' + (await db.query('SELECT status FROM agent_runs WHERE id=$1', [seeded.runId])).rows[0].status) }
  })
  await step('board-create-issue', O, async (page, rec) => {
    await page.goto(app('/?section=projects')); await settle(page)
    rec.notes.push('buttons=' + JSON.stringify((await page.getByRole('button').allInnerTexts()).filter(Boolean).slice(0, 40)))
    const nb = page.getByRole('button', { name: /新建任务|创建任务|添加任务/ }).first()
    rec.notes.push('new task count=' + await nb.count())
    if (await nb.count()) { await nb.click(); await settle(page); await page.keyboard.type('QA 新建任务'); await page.keyboard.press('Enter'); await page.waitForTimeout(2500); rec.notes.push('created rows=' + (await db.query(`SELECT count(*) c FROM issues WHERE "userId"=$1 AND title LIKE 'QA 新建任务%'`, [scope.owner.userId])).rows[0].c) }
  })
  await step('board-new-project', O, async (page, rec) => {
    await page.goto(app('/?section=projects')); await settle(page)
    await page.getByRole('button', { name: '新建项目', exact: true }).first().click(); await settle(page)
    const d = page.getByRole('dialog').first(); rec.notes.push('dialog=' + (await d.innerText().catch(() => 'none')).slice(0, 150).replace(/\n/g, ' / '))
    const tb = d.getByRole('textbox').first(); if (await tb.count()) { await tb.fill('QA 项目'); await d.getByRole('button', { name: /创建/ }).last().click(); await page.waitForTimeout(2500) }
    rec.notes.push('projects=' + (await db.query(`SELECT count(*) c FROM projects WHERE name='QA 项目'`).catch(e => ({ rows: [{ c: e.message }] }))).rows[0].c)
  })
  await step('issue-status-change', O, async (page, rec) => {
    await page.goto(app(`/?issue=${seeded.ids[0]}`)); await settle(page)
    await page.getByRole('button', { name: /任务状态/ }).first().click(); await settle(page)
    rec.notes.push('menu=' + JSON.stringify(await page.getByRole('menuitem').allInnerTexts().catch(() => []).then(x => x.slice(0, 10))) + JSON.stringify(await page.getByRole('option').allInnerTexts().then(x => x.slice(0, 10))))
    const opt = page.getByRole('menuitem', { name: /进行中/ }).or(page.getByRole('option', { name: /进行中/ })).first()
    await opt.click(); await page.waitForTimeout(2000)
    rec.notes.push('db status=' + (await db.query('SELECT status FROM issues WHERE id=$1', [seeded.ids[0]])).rows[0].status)
  })
  await step('issue-prev-next', O, async (page, rec) => {
    await page.goto(app(`/?issue=${seeded.ids[1]}`)); await settle(page)
    const prev = page.getByRole('button', { name: '上一个任务' }), next = page.getByRole('button', { name: '下一个任务' })
    rec.notes.push(`prev enabled=${await prev.isEnabled()} next enabled=${await next.isEnabled()}`)
    const before = page.url()
    await prev.click({ timeout: 5000 }).catch(e => rec.notes.push('prev click: ' + e.message.split('\n')[0]))
    await settle(page); rec.notes.push('url changed=' + (page.url() !== before))
  })
  await step('issue-comment', O, async (page, rec) => {
    await page.goto(app(`/?issue=${seeded.ids[0]}`)); await settle(page)
    await page.getByRole('textbox', { name: '评论内容' }).click(); await page.keyboard.type('QA 评论')
    await page.getByRole('button', { name: '发送评论' }).click(); await page.waitForTimeout(2500)
    rec.notes.push('comment visible=' + await page.getByText('QA 评论').count())
  })
  await step('issue-team-combobox', O, async (page, rec) => {
    await page.goto(app(`/?issue=${seeded.ids[0]}`)); await settle(page)
    await page.getByRole('combobox', { name: '团队' }).click(); await settle(page)
    rec.notes.push('opts=' + JSON.stringify(await page.getByRole('option').allInnerTexts()))
    const unnamed = await page.evaluate(() => [...document.querySelectorAll('input,textarea,[contenteditable=true]')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && !e.getAttribute('aria-label') && !(e.labels && e.labels[0]) && !e.getAttribute('placeholder') }).map(e => e.outerHTML.slice(0, 200)))
    rec.notes.push('unnamed inputs=' + JSON.stringify(unnamed))
  })
  await step('issue-more-menu', O, async (page, rec) => {
    await page.goto(app(`/?issue=${seeded.ids[0]}`)); await settle(page)
    await page.getByRole('button', { name: '更多任务操作' }).click(); await settle(page)
    rec.notes.push('menu=' + JSON.stringify(await page.getByRole('menuitem').allInnerTexts()))
  })
  await step('search-palette-select', O, async (page, rec) => {
    await page.goto(app('/?section=projects')); await settle(page)
    await page.getByRole('button', { name: '全局搜索' }).click(); await settle(page)
    await page.keyboard.type('QA 任务 B'); await page.waitForTimeout(1500)
    rec.notes.push('options=' + JSON.stringify(await page.getByRole('option').allInnerTexts()))
    await page.keyboard.press('Enter'); await settle(page)
    rec.notes.push('url=' + page.url().replace(ORIGIN, ''))
  })
  await step('search-palette-click-option', O, async (page, rec) => {
    await page.goto(app('/?section=projects')); await settle(page)
    await page.getByRole('button', { name: '全局搜索' }).click(); await settle(page)
    await page.keyboard.type('QA 任务 C'); await page.waitForTimeout(1500)
    const o = page.getByRole('option', { name: /QA 任务 C/ }).first()
    rec.notes.push('aria-disabled=' + await o.getAttribute('aria-disabled') + ' data-disabled=' + await o.getAttribute('data-disabled'))
    await o.click({ timeout: 5000 }); await settle(page); rec.notes.push('url=' + page.url().replace(ORIGIN, ''))
  })
  await step('suggestion-actions', O, async (page, rec) => {
    await page.goto(app('/?section=suggestions')); await settle(page)
    rec.notes.push('buttons=' + JSON.stringify((await page.locator('main').last().getByRole('button').allInnerTexts().catch(() => [])).filter(Boolean)))
    rec.notes.push('aria=' + JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('button')].filter(b => b.offsetParent).map(b => b.getAttribute('aria-label') || b.innerText).filter(Boolean).slice(0, 40))))
  })
  await step('artifacts-open', O, async (page, rec) => {
    await page.goto(app('/?section=artifacts')); await settle(page)
    const a = page.getByText('QA 产物').first(); rec.notes.push('artifact listed=' + await a.count())
    if (await a.count()) { await a.click(); await settle(page); rec.notes.push('after open: ' + (await page.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' / ')) }
  })
  await step('account-rename', O, async (page, rec) => {
    await page.goto(app('/settings?section=account')); await settle(page)
    const name = page.getByRole('textbox', { name: '名称' }); await name.fill('QA Owner')
    await page.getByRole('button', { name: '保存', exact: true }).click(); await page.waitForTimeout(2000)
    rec.notes.push('db name=' + (await db.query('SELECT name FROM "user" WHERE id=$1', [scope.owner.userId])).rows[0].name)
  })
  await step('account-avatar-filechooser', O, async (page, rec) => {
    const fc = page.waitForEvent('filechooser', { timeout: 4000 }).then(() => true).catch(() => false)
    await page.getByRole('button', { name: '更换', exact: true }).click(); rec.notes.push('filechooser=' + await fc)
  })
  await step('security-change-password-wrong', O, async (page, rec) => {
    await page.goto(app('/settings?section=security')); await settle(page)
    await page.getByRole('button', { name: '修改密码' }).click(); await settle(page)
    const d = page.getByRole('dialog').first(); rec.notes.push('dialog=' + (await d.innerText()).slice(0, 200).replace(/\n/g, ' / '))
    const pw = d.locator('input[type=password]'); const c = await pw.count(); rec.notes.push('pw inputs=' + c)
    if (c >= 2) { await pw.nth(0).fill('wrong-password-123'); for (let i = 1; i < c; i++) await pw.nth(i).fill('NewPassw0rd!QA'); await d.getByRole('button', { name: /保存|修改|更新|确定/ }).last().click(); await page.waitForTimeout(2500); rec.notes.push('after=' + (await d.innerText().catch(() => 'closed')).slice(0, 200).replace(/\n/g, ' / ')) }
  })
  await step('preferences-theme-language', O, async (page, rec) => {
    await page.goto(app('/settings?section=preferences')); await settle(page)
    rec.notes.push('controls=' + JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('main button, main [role=switch], main [role=combobox], main [role=radio]')].filter(b => b.offsetParent).map(b => (b.getAttribute('role') || 'button') + ':' + (b.getAttribute('aria-label') || b.innerText)).slice(0, 40))))
    const dark = page.getByRole('radio', { name: /深色/ }).or(page.getByRole('button', { name: /深色/ })).first()
    if (await dark.count()) { await dark.click(); await settle(page); rec.notes.push('html class=' + await page.evaluate(() => document.documentElement.className)); await shot(page, 'pref-dark') ; const light = page.getByRole('radio', { name: /浅色/ }).or(page.getByRole('button', { name: /浅色/ })).first(); if (await light.count()) await light.click() }
  })
  await step('notifications-unnamed-checkboxes', O, async (page, rec) => {
    await page.goto(app('/settings?section=notifications')); await settle(page)
    rec.notes.push(JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('input[type=checkbox], [role=checkbox]')].map(e => ({ html: e.outerHTML.slice(0, 160), ariaHidden: e.getAttribute('aria-hidden') ?? e.closest('[aria-hidden]')?.getAttribute('aria-hidden') })).slice(0, 3))))
    const sw = page.getByRole('switch').first(); const b = await sw.getAttribute('aria-checked'); await sw.click(); await page.waitForTimeout(1500)
    await page.reload(); await settle(page); rec.notes.push(`switch persisted: before=${b} after-reload=${await page.getByRole('switch').first().getAttribute('aria-checked')}`)
    await page.getByRole('switch').first().click(); await page.waitForTimeout(1000)
  })
  await step('notifications-delivery-buttons', O, async (page, rec) => {
    const im = page.getByRole('button', { name: '立即' }).or(page.getByRole('radio', { name: '立即' })).first()
    rec.notes.push('立即 count=' + await im.count() + ' pressed=' + await im.getAttribute('aria-pressed') + ' checked=' + await im.getAttribute('aria-checked') + ' state=' + await im.getAttribute('data-state'))
  })
  await step('connections-refresh-status', O, async (page, rec) => {
    await page.goto(app('/settings?section=connections')); await settle(page)
    const reqs = []; page.on('request', r => { if (r.url().startsWith(ORIGIN)) reqs.push(r.method() + ' ' + new URL(r.url()).pathname) })
    await page.getByRole('button', { name: '刷新状态' }).first().click(); await page.waitForTimeout(2000)
    rec.notes.push('requests=' + JSON.stringify(reqs.slice(0, 5)))
  })
  await step('privacy-export', O, async (page, rec) => {
    await page.goto(app('/settings?section=privacy')); await settle(page)
    rec.notes.push('page=' + (await page.locator('main').last().innerText()).slice(0, 400).replace(/\n/g, ' / '))
  })
  await step('activity-filters', O, async (page, rec) => {
    await page.goto(app('/settings?section=activity')); await settle(page)
    rec.notes.push('page=' + (await page.locator('main').last().innerText()).slice(0, 400).replace(/\n/g, ' / '))
  })
  await step('models-page', O, async (page, rec) => {
    await page.goto(app('/settings?section=models')); await settle(page)
    rec.notes.push('page=' + (await page.locator('main').last().innerText()).slice(0, 400).replace(/\n/g, ' / '))
  })
  await step('logins-page', O, async (page, rec) => {
    await page.goto(app('/settings?section=logins')); await settle(page)
    rec.notes.push('page=' + (await page.locator('main').last().innerText()).slice(0, 400).replace(/\n/g, ' / '))
  })
  await step('computers-page', O, async (page, rec) => {
    await page.goto(app('/settings?section=computers')); await settle(page)
    rec.notes.push('page=' + (await page.locator('main').last().innerText()).slice(0, 400).replace(/\n/g, ' / '))
  })
  await step('permissions-page', O, async (page, rec) => {
    await page.goto(app('/settings?section=permissions')); await settle(page)
    rec.notes.push('page=' + (await page.locator('main').last().innerText()).slice(0, 400).replace(/\n/g, ' / '))
    rec.notes.push('controls=' + JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('main button, main [role=switch], main [role=combobox]')].filter(b => b.offsetParent).map(b => (b.getAttribute('role') || 'button') + ':' + (b.getAttribute('aria-label') || b.innerText)).slice(0, 30))))
  })
  await step('teams-create', O, async (page, rec) => {
    await page.goto(app('/settings/teams?create=1')); await settle(page)
    await page.getByPlaceholder('例如：研发').fill('QA 团队'); await page.waitForTimeout(300)
    rec.notes.push('identifier auto=' + await page.getByPlaceholder('例如：ENG').inputValue())
    if (!(await page.getByPlaceholder('例如：ENG').inputValue())) await page.getByPlaceholder('例如：ENG').fill('QAT')
    await page.getByRole('button', { name: '创建团队' }).last().click(); await page.waitForTimeout(3000)
    rec.notes.push('url=' + page.url().replace(ORIGIN, '') + ' alerts=' + JSON.stringify(await page.getByRole('alert').allInnerTexts()))
    rec.notes.push('teams in db=' + JSON.stringify((await db.query(`SELECT name, identifier FROM teams`).catch(e => ({ rows: [e.message] }))).rows))
  })
  await step('members-manage-peer', O, async (page, rec) => {
    await page.goto(app('/settings/members')); await settle(page)
    await page.getByRole('button', { name: /管理 Test peer/ }).click(); await settle(page)
    rec.notes.push('opened=' + (await page.getByRole('dialog').or(page.getByRole('menu')).first().innerText().catch(() => 'none')).slice(0, 200).replace(/\n/g, ' / '))
    const unnamed = await page.evaluate(() => [...document.querySelectorAll('input')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && !e.getAttribute('aria-label') && !(e.labels && e.labels[0]) }).map(e => e.outerHTML.slice(0, 200)))
    rec.notes.push('unnamed inputs=' + JSON.stringify(unnamed))
  })
  await step('members-export-csv', O, async (page, rec) => {
    await page.goto(app('/settings/members')); await settle(page)
    const dl = page.waitForEvent('download', { timeout: 5000 }).then(d => d.suggestedFilename()).catch(() => null)
    await page.getByRole('button', { name: '导出 CSV' }).click(); rec.notes.push('download=' + await dl)
  })
  await step('workspace-new-create', O, async (page, rec) => {
    await page.goto(app('/workspaces/new')); await settle(page)
    await page.getByRole('textbox', { name: '工作区名称' }).fill('QA 第二工作区'); await page.waitForTimeout(500)
    const slug = page.getByRole('textbox', { name: '工作区网址' }); rec.notes.push('auto slug for CJK name=' + await slug.inputValue())
    await slug.fill('qa-second-' + Date.now().toString(36))
    await page.getByRole('button', { name: '创建工作区' }).click({ timeout: 5000 }); await page.waitForTimeout(4000)
    rec.notes.push('url=' + page.url().replace(ORIGIN, ''))
  })
  await step('workspace-switch-back', O, async (page, rec) => {
    await page.goto(app('/')); await settle(page)
    await page.getByRole('button', { name: '工作区菜单', exact: true }).click(); await settle(page)
    rec.notes.push('menu=' + JSON.stringify(await page.getByRole('menuitem').allInnerTexts()))
  })
  await step('device-code-invalid', O, async (page, rec) => {
    await page.goto(app('/device')); await settle(page)
    const tb = page.getByRole('textbox').first(); await tb.fill('ABCD-EFGH')
    await page.getByRole('button').filter({ hasNotText: /^$/ }).last().click(); await page.waitForTimeout(2500)
    rec.notes.push('page=' + (await page.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' / '))
  })
  await step('plugins-tab-skills', O, async (page, rec) => {
    await page.goto(app('/?section=plugins')); await settle(page)
    rec.notes.push('page=' + (await page.locator('main').last().innerText().catch(() => '')).slice(0, 300).replace(/\n/g, ' / '))
  })
  await step('acceptance-route', O, async (page, rec) => {
    await page.goto(app('/acceptance')); await settle(page)
    rec.notes.push('page=' + (await page.locator('body').innerText()).slice(0, 200).replace(/\n/g, ' / '))
  })
  await step('issue-factory-acceptance-button', O, async (page, rec) => {
    await page.goto(app(`/?issue=${seeded.ids[0]}`)); await settle(page)
    rec.notes.push('技能验收 buttons=' + await page.getByRole('button', { name: /技能验收/ }).count())
  })

  await step('factory-route-and-view', O, async (page, rec) => {
    const src = randomUUID()
    await db.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,$2,'user_message',$3,'{"text":"QA factory request"}')`, [src, scope.owner.userId, `qa:${src}`])
    await page.goto(app(`/?issue=${seeded.ids[1]}`)); await settle(page)
    const r = await page.evaluate(async b => { const res = await fetch('/mikka/api/factory/tasks/route', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: res.status, body: (await res.text()).slice(0, 300) } }, { issueId: seeded.ids[1], sourceEventId: src, eventId: src, rationale: 'QA 路由' })
    rec.notes.push('route api=' + JSON.stringify(r))
    const l = await page.evaluate(async id => { const res = await fetch('/mikka/api/factory/tasks?issueId=' + id); return { status: res.status, body: (await res.text()).slice(0, 300) } }, seeded.ids[1])
    rec.notes.push('list api=' + JSON.stringify(l))
    await page.reload(); await settle(page); await page.waitForTimeout(1500)
    rec.notes.push('factory UI text=' + JSON.stringify((await page.locator('body').innerText()).match(/(Factory|工厂|技能验收|澄清|规格|执行|审批|待处理|流程)[^\n]{0,40}/g)?.slice(0, 8)))
    rec.notes.push('buttons=' + JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('button')].filter(b => b.offsetParent).map(b => b.getAttribute('aria-label') || b.innerText).filter(Boolean).slice(10, 60))))
  })
  await step('factory-acceptance-open', O, async (page, rec) => {
    const b = page.getByRole('button', { name: /技能验收|验收|Factory/ }).first()
    rec.notes.push('count=' + await b.count())
    if (await b.count()) { await b.click(); await settle(page); rec.notes.push('dialog=' + (await page.getByRole('dialog').first().innerText().catch(() => 'none')).slice(0, 300).replace(/\n/g, ' / ')) }
  })
  await step('board-new-task-submit', O, async (page, rec) => {
    await page.goto(app('/')); await settle(page)
    await page.getByRole('button', { name: '看板', exact: true }).click(); await settle(page)
    await page.getByRole('button', { name: '新建任务' }).first().click(); await settle(page)
    const d = page.getByRole('dialog').first()
    rec.notes.push('dialog=' + (await d.innerText()).slice(0, 200).replace(/\n/g, ' / '))
    await page.keyboard.type('QA 新建任务：检查首页'); await page.waitForTimeout(400)
    const c = d.getByRole('button', { name: '创建任务' }); rec.notes.push('create enabled=' + await c.isEnabled())
    if (await c.isEnabled()) { await c.click(); await page.waitForTimeout(8000); rec.notes.push('after url=' + page.url().replace(ORIGIN, '') + ' dialogOpen=' + await page.getByRole('dialog').count() + ' toasts=' + JSON.stringify(await page.locator('[data-sonner-toast]').allInnerTexts())) }
    rec.notes.push('issues created=' + (await db.query(`SELECT count(*) c FROM issues WHERE "userId"=$1 AND title LIKE '%检查首页%'`, [scope.owner.userId])).rows[0].c)
  })
  await step('chat-reply-after-send', O, async (page, rec) => {
    await page.goto(app('/')); await settle(page); await page.waitForTimeout(3000)
    rec.notes.push('chat tail=' + (await page.locator('body').innerText()).slice(-400).replace(/\n/g, ' / '))
  })
  // Peer
  await step('peer-issue-owner-private', P, async (page, rec) => {
    await page.goto(app(`/?issue=${seeded.ids[0]}`)); await settle(page)
    rec.notes.push('page=' + (await page.locator('body').innerText()).slice(0, 200).replace(/\n/g, ' / '))
  })
  await step('peer-members-readonly', P, async (page, rec) => {
    await page.goto(app('/settings/members')); await settle(page)
    rec.notes.push('invite enabled=' + await page.getByRole('button', { name: '邀请成员' }).isEnabled())
    const dl = page.waitForEvent('download', { timeout: 5000 }).then(d => d.suggestedFilename()).catch(() => null)
    await page.getByRole('button', { name: '导出 CSV' }).click(); rec.notes.push('download=' + await dl)
  })
  await step('peer-permissions-hidden', P, async (page, rec) => {
    await page.goto(app('/settings?section=permissions')); await settle(page)
    rec.notes.push('heading=' + await page.getByRole('heading').first().innerText())
  })
  await step('peer-teams-create', P, async (page, rec) => {
    await page.goto(app('/settings/teams?create=1')); await settle(page)
    const d = page.getByRole('dialog').first(); rec.notes.push('dialog=' + (await d.innerText().catch(() => 'none')).slice(0, 160).replace(/\n/g, ' / '))
  })
  await O.ctx.close(); await P.ctx.close()
} finally {
  writeFileSync(`${OUT}/steps.json`, JSON.stringify(steps, null, 1))
  await browser.close(); await scope.release({ outcome: 'dirty' }).catch(() => {}); await db.end(); log('done')
}
