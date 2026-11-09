// Expo Web screenshots for #1671's iOS part: lists show tasks only, threads open inside their task, and a task is
// one conversation with a divider only where it switched Agent, never 「尝试」 (2026-11-09).
// Our own labelled fixtures; no other product's source or wording.
//
//   MOBILE_WEB_DIST=/path/to/expo-web-export SCREENSHOT_OUT=/path/to/out node apps/mobile/scripts/tasks-screenshots.mjs
//
// Serves the exported apps/mobile web bundle, answers its API with the fixtures below, and writes light and dark
// frames of the Bot tab, the 任务 tab, a task's detail and an attempt's thread at 393 × 852.
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { chromium } from '@playwright/test'

const dist = process.env.MOBILE_WEB_DIST || '/tmp/mikka-mobile-web'
const outDir = process.env.SCREENSHOT_OUT || '/tmp/mikka-mobile-tasks'
const port = Number(process.env.SCREENSHOT_PORT || 4174)

const USER = '11111111-1111-4111-8111-111111111111'
const WORKSPACE = '22222222-2222-4222-8222-222222222222'
const COORDINATOR = '33333333-3333-4333-8333-333333333330'
const FRONTEND = '33333333-3333-4333-8333-333333333331'
const DESIGN = '33333333-3333-4333-8333-333333333332'
const RESEARCH = '33333333-3333-4333-8333-333333333333'
const TASK = '44444444-4444-4444-8444-444444444471'
const RUN1 = '55555555-5555-4555-8555-555555555551'
const RUN2 = '55555555-5555-4555-8555-555555555552'
const RUN0 = '55555555-5555-4555-8555-555555555550'
const RUN3 = '55555555-5555-4555-8555-555555555553'
const RUN4 = '55555555-5555-4555-8555-555555555554'

const ago = (days, hours = 0) => new Date(Date.now() - days * 86_400_000 - hours * 3_600_000).toISOString()
const bot = (id, name, color, shape) => ({ id, name, color, shape })
const frontend = bot(FRONTEND, '前端', 'orange', 'squircle')
const design = bot(DESIGN, '设计师', 'rose', 'fleur')
const research = bot(RESEARCH, '研究员', 'bleu', 'nuage')

const task = (id, identifier, title, extra) => ({ id, identifier, title, status: 'todo', priority: 'normal', owner: '阿宁', updatedAt: ago(0), createdAt: ago(1), blocked: null, schedule: null, bot: null, ...extra })
const tasks = [
  task(TASK, '#1471', '修复 iOS 登录回调', { group: 'pending', state: 'waiting', reason: 'pr_review', status: 'review', priority: 'high', bot: frontend, createdAt: ago(0, 3) }),
  task('44444444-4444-4444-8444-444444444477', '#1477', '登录页要不要换新导航', { group: 'pending', state: 'failed', reason: null, status: 'doing', bot: design, createdAt: ago(0, 5) }),
  task('44444444-4444-4444-8444-444444444480', '#1480', '同步十月发票', { group: 'pending', state: 'blocked', reason: 'quota', status: 'doing', bot: design, createdAt: ago(0, 6) }),
  task('44444444-4444-4444-8444-444444444462', '#1462', '整理竞品报告', { group: 'running', state: 'running', reason: null, status: 'doing', bot: research, createdAt: ago(5) }),
  task('44444444-4444-4444-8444-444444444401', '#1401', '行业研究周报', { group: 'running', state: 'queued', reason: null, status: 'doing', priority: 'low', bot: research, createdAt: ago(9), schedule: { label: '每天 09:00', nextAt: new Date(Date.now() + 86_400_000).toISOString() } }),
  task('44444444-4444-4444-8444-444444444446', '#1446', '设置页改用原生表单', { group: 'todo', state: 'todo', reason: 'blocked_by', blockedBy: '#1462', priority: 'none', createdAt: ago(2) }),
  ...Array.from({ length: 12 }, (_, index) => task(`44444444-4444-4444-8444-4444444445${String(index).padStart(2, '0')}`, `#13${index + 10}`, `已完成的任务 ${index + 1}`, { group: 'done', state: index === 1 ? 'canceled' : 'done', reason: null, status: index === 1 ? 'canceled' : 'done', bot: frontend, createdAt: ago(10 + index) })),
]

const detail = {
  task: {
    ...tasks[0],
    description: 'iOS 上 Google 登录回来以后停在空白页，修一下。',
    agent: { harness: 'claude_code', model: 'Sonnet 5.5' },
    place: { kind: 'laptop', name: 'MacBook' },
    flow: { stage: 'handoff', needsYou: { kind: 'pr_review', since: ago(0, 1) }, review: { verdict: 'changes_requested' } },
  },
  // A task is one conversation (2026-11-08): two Codex runs read as one, the failure switches to Claude Code; its
  // implementation is reviewed once (需要修改), fixed, and handed to you (2026-11-04-2200).
  activity: [
    { kind: 'attempt', runId: RUN4, n: 5, group: 'waiting', state: 'waiting', harness: 'claude_code', stage: 'fix', createdAt: ago(0, 1), failed: false },
    { kind: 'attempt', runId: RUN3, n: 4, group: 'resolved', state: 'done', harness: 'claude_code', stage: 'review', createdAt: ago(0, 2), failed: false },
    { kind: 'attempt', runId: RUN2, n: 3, group: 'resolved', state: 'done', pullRequest: { number: 1471 }, harness: 'claude_code', stage: 'implement', createdAt: ago(0, 3), failed: false },
    { kind: 'attempt', runId: RUN1, n: 2, group: 'blocked', state: 'failed', harness: 'codex', createdAt: ago(1), failed: true },
    { kind: 'attempt', runId: RUN0, n: 1, group: 'resolved', state: 'waiting', harness: 'codex', createdAt: ago(1, 1), failed: false },
    { kind: 'created', by: 'Coordinator', createdAt: ago(1, 2) },
  ],
}

// The task's two attempts: the first failed on Codex (its raw error stays inside it), the second runs on Claude Code.
const threadOf = (id, harness, status, items, error) => ({
  live: { runs: [] },
  thread: { id, name: '修复 iOS 登录回调', status, by: '前端', harness, device: { id: 'd', name: 'MacBook', kind: 'laptop' }, createdAt: ago(1), finishedAt: null, group: 'waiting', attempts: 2 },
  active: false, working: false, paused: null, summary: null, error, items,
})
const threads = {
  [RUN0]: threadOf(RUN0, 'codex', 'waiting', [
    { kind: 'person', id: 'p0', text: '先看看 iOS 登录回调停在哪一步', mine: true, at: Date.now() - 95_000_000 },
    { kind: 'agent', id: 'a0', text: '回调回到了 app，但没有带上会话。要我直接改回调地址吗？', at: Date.now() - 94_000_000 },
  ], null),
  [RUN1]: threadOf(RUN1, 'codex', 'failed', [
    { kind: 'person', id: 'p1', text: 'iOS 上 Google 登录回来以后停在空白页，修一下', mine: true, at: Date.now() - 90_000_000 },
    { kind: 'steps', id: 's1', count: 4, at: Date.now() - 89_000_000 },
  ], 'agent_exited: codex exited with code 1 (E_SANDBOX_NETWORK)'),
  [RUN4]: threadOf(RUN4, 'claude_code', 'waiting', [
    { kind: 'agent', id: 'a4', text: '按审阅改好了：返回键不再回到回调页，补了一个测试。PR #1471 已更新，等你审阅。', at: Date.now() - 3_000_000 },
  ], null),
  [RUN3]: threadOf(RUN3, 'claude_code', 'waiting', [
    { kind: 'agent', id: 'a3', text: '独立审查：回调地址和测试都对得上；还差一处：返回键会回到回调页。', at: Date.now() - 7_000_000 },
  ], null),
  [RUN2]: threadOf(RUN2, 'claude_code', 'waiting', [
    { kind: 'steps', id: 's2', count: 9, at: Date.now() - 9_000_000 },
    { kind: 'agent', id: 'a2', text: '回调地址少了 `mikka://` 的信任来源，加上以后在模拟器里登录能回到聊天列表。PR #1471 已开，等你审阅。', at: Date.now() - 8_000_000 },
  ], null),
}

const homeBots = [
  { id: COORDINATOR, name: 'Coordinator', color: 'encre', shape: 'cercle', coordinator: true, line: '验证命令仍待你决定', at: ago(3) },
  { ...frontend, line: 'PR #1471 已开，等你看一下。', at: ago(0, 3) },
  { ...design, line: '登录页要不要换成新导航？我放了两版对比。', at: ago(0, 5) },
  { ...research, line: '竞品报告的第一版初稿整理好了。', at: ago(2) },
]

const home = {
  user: { id: USER, name: '阿宁', email: 'fixture@example.com', image: null },
  workspace: { id: WORKSPACE, name: '个人' },
  workspaces: [{ id: WORKSPACE, name: '个人' }],
  bots: homeBots,
  groups: [],
  threads: { running: 2, waiting: 2 },
  suggestions: 0,
  live: { ownerId: USER, workspaceId: WORKSPACE },
}

const session = {
  session: { id: 'sess-fixture', userId: USER, token: 'fixture', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  user: { id: USER, name: '阿宁', email: 'fixture@example.com', emailVerified: true, image: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
}

const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })

function apiResponse(url) {
  const path = new URL(url).pathname
  if (path.endsWith('/api/auth/get-session')) return json(session)
  if (path === '/api/version') return json({})
  if (path === '/api/mobile/home') return json(home)
  if (path === '/api/mobile/tasks') return json({ tasks })
  if (path.startsWith('/api/mobile/tasks/')) return json(detail)
  if (path.startsWith('/api/mobile/threads/')) return json(threads[path.split('/').pop()] ?? threads[RUN2])
  if (path === '/api/mobile/chat-order') return json({ chats: [] })
  if (path === '/api/pending-actions') return json([])
  if (path.startsWith('/api/live/')) return json({ error: 'offline' }, 404)
  return null
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }

function serve(directory, listenPort) {
  return new Promise(resolve => {
    const server = createServer((request, response) => {
      const pathname = decodeURIComponent(new URL(request.url || '/', 'http://127.0.0.1').pathname)
      if (pathname.includes('..')) { response.writeHead(400); response.end(); return }
      let file = join(directory, pathname)
      if (!existsSync(file) || statSync(file).isDirectory()) {
        if (extname(pathname)) { response.writeHead(404); response.end(); return }
        file = join(directory, 'index.html')
      }
      response.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
      createReadStream(file).pipe(response)
    })
    server.listen(listenPort, '127.0.0.1', () => resolve(server))
  })
}

async function open(page, origin, path, ready) {
  await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.getByText(ready).first().waitFor({ timeout: 20_000 })
  await page.waitForTimeout(500)
  await page.evaluate(() => document.fonts.ready)
}

async function run() {
  if (!existsSync(join(dist, 'index.html'))) throw new Error(`No Expo Web export at ${dist}`)
  mkdirSync(outDir, { recursive: true })
  const server = await serve(dist, port)
  const origin = `http://127.0.0.1:${port}`
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {})
  const problems = []
  try {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, colorScheme: theme, hasTouch: true, isMobile: true, locale: 'zh-CN' })
      const page = await context.newPage()
      page.on('pageerror', error => problems.push(`${theme}: ${error}`))
      await page.route('**/*', async route => {
        const url = route.request().url()
        const hit = url.startsWith(origin) ? apiResponse(url) : null
        if (!hit && url.startsWith(`${origin}/api/`)) problems.push(`${theme}: unanswered ${new URL(url).pathname}`)
        return hit ? route.fulfill(hit) : route.continue()
      })
      await open(page, origin, '/', '前端')
      await page.screenshot({ path: join(outDir, `${theme}-1-bot.png`) })
      await open(page, origin, '/tasks', '修复 iOS 登录回调')
      await page.screenshot({ path: join(outDir, `${theme}-2-tasks.png`) })
      // 已完成 opened and scrolled to: closed tasks keep the board's ✓ / ✕ icons.
      await page.getByRole('button', { name: '已完成，12' }).click()
      await page.getByText('已完成的任务 2').scrollIntoViewIfNeeded()
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(outDir, `${theme}-2b-done.png`) })
      await page.getByRole('button', { name: '已完成，12' }).click()
      await page.getByText('修复 iOS 登录回调').first().click()
      await page.getByText('活动').waitFor({ timeout: 20_000 })
      await page.waitForTimeout(500)
      await page.screenshot({ path: join(outDir, `${theme}-3-task.png`) })
      await page.getByText('换 Claude Code', { exact: true }).first().click()
      await page.getByText('Codex 没跑通 · 换 Claude Code 继续').waitFor({ timeout: 20_000 })
      await page.waitForTimeout(500)
      await page.screenshot({ path: join(outDir, `${theme}-4-conversation.png`) })
      // 审阅 is one result card; it opens to the reviewer's transcript.
      const review = page.getByRole('button', { name: /^审阅/ })
      if (await review.count()) {
        await review.first().click(); await page.waitForTimeout(400)
        await page.screenshot({ path: join(outDir, `${theme}-4b-review-open.png`) })
      }
      // The top of the conversation: the task's one stage and what it needs from you.
      await page.mouse.move(196, 400); await page.mouse.wheel(0, -5000); await page.waitForTimeout(400)
      await page.screenshot({ path: join(outDir, `${theme}-4c-stage.png`) })
      await context.close()
    }
  } finally {
    await browser.close()
    server.close()
  }
  if (problems.length) console.log([...new Set(problems)].join('\n'))
  console.log(`screenshots in ${outDir}`)
}

await run()
