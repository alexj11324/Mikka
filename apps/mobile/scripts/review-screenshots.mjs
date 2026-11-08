// Expo Web screenshots for #1738, the iPhone code review: a task's summary row (R2a), the review (R2) and its checks,
// a file's diff (R3), a line comment (R3b) and the states (running, merged, teammate, empty, machine reclaimed).
// Our own labelled fixtures; the server shapes are the contract proposed for #1722.
//
//   MOBILE_WEB_DIST=/path/to/expo-web-export SCREENSHOT_OUT=/path/to/out node apps/mobile/scripts/review-screenshots.mjs
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { chromium } from '@playwright/test'

const dist = process.env.MOBILE_WEB_DIST || '/tmp/mikka-mobile-web'
const outDir = process.env.SCREENSHOT_OUT || '/tmp/mikka-mobile-review'
const port = Number(process.env.SCREENSHOT_PORT || 4175)

const USER = '11111111-1111-4111-8111-111111111111'
const WORKSPACE = '22222222-2222-4222-8222-222222222222'
const FRONTEND = '33333333-3333-4333-8333-333333333331'
const TASK = '44444444-4444-4444-8444-444444444471'
const ago = (days, hours = 0) => new Date(Date.now() - days * 86_400_000 - hours * 3_600_000).toISOString()

const summary = { pr: { number: 1471, state: 'open' }, files: 3, additions: 42, deletions: 7, checks: { failed: 1, passed: 5, pending: 0 }, running: false }
const checks = [
  { id: 'ios-unit', name: 'ios-unit', conclusion: 'failure', logExcerpt: 'FAIL apps/mobile/lib/auth/callback.test.ts\n  ✕ returns to the chat after sign-in (31 ms)\n    Expected: "/chats"  Received: "mikka://chat"' },
  ...['lint', 'typecheck', 'web-unit', 'database', 'build'].map(name => ({ id: name, name, conclusion: 'success' })),
]
const files = [
  { path: 'apps/mobile/lib/auth/callback.ts', additions: 18, deletions: 4, comments: 0, status: 'modified' },
  { path: 'apps/mobile/lib/auth/callback.test.ts', additions: 21, deletions: 0, comments: 0, status: 'added' },
  { path: 'apps/mobile/app.config.ts', additions: 3, deletions: 3, comments: 0, status: 'modified' },
]
const owner = { canSend: true, canMerge: true }
const scenarios = {
  review: { summary, source: { kind: 'machine', at: ago(0, 1), live: false }, files, checks, permissions: owner },
  running: { summary: { ...summary, pr: null, running: true, checks: { failed: 0, passed: 0, pending: 0 } }, source: { kind: 'machine', at: ago(0), live: true }, files, checks: [], permissions: owner },
  merged: { summary: { ...summary, pr: { number: 1471, state: 'merged' } }, source: { kind: 'pr', at: ago(0, 1), live: false }, files, checks, permissions: owner },
  teammate: { summary, source: { kind: 'machine', at: ago(0, 1), live: false }, files, checks, permissions: { canSend: false, canMerge: false } },
  empty: { summary: { ...summary, files: 0, additions: 0, deletions: 0 }, source: { kind: 'machine', at: ago(0), live: false }, files: [], checks: [], permissions: owner },
  reclaimed: { summary, source: { kind: 'checkpoint', at: ago(1, 2), live: false }, files: [...files.slice(0, 2), { ...files[2], path: 'apps/mobile/ios/Podfile.lock', additions: 1840, deletions: 1202, tooLarge: true }], checks, permissions: owner },
}
let scenario = 'review'
/** Each state is its own task, so no read cached under one state answers another. */
const taskOf = name => `44444444-4444-4444-8444-4444444${String(Object.keys(scenarios).indexOf(name) + 10).padStart(5, '0')}`
const scenarioOf = path => Object.keys(scenarios).find(name => path.includes(taskOf(name))) ?? scenario

const fileDiff = path => ({
  path,
  hunks: [{ header: '@@ -20,7 +20,9 @@ export async function handleCallback', lines: [
    { kind: 'ctx', old: 20, new: 20, text: 'export async function handleCallback(url) {' },
    { kind: 'ctx', old: 21, new: 21, text: '  const params = new URL(url).searchParams' },
    { kind: 'del', old: 22, text: "  const redirect = 'mikka://chat'" },
    { kind: 'add', new: 22, text: "  const redirect = config.authRedirect ?? '/chats'" },
    { kind: 'add', new: 23, text: "  if (!params.get('code')) return router.replace('/sign-in')" },
    { kind: 'ctx', old: 23, new: 24, text: "  await session.exchange(params.get('code'))" },
    { kind: 'del', old: 24, text: '  router.push(redirect)' },
    { kind: 'add', new: 25, text: '  router.replace(redirect)' },
    { kind: 'ctx', old: 25, new: 26, text: '}' },
  ] }],
  comments: [{ id: 'c1', line: 25, side: 'new', body: '这里补一个 replace 的测试，确认返回键不会回到回调页。', author: '阿宁', sent: true }],
})

const detail = {
  task: { id: TASK, identifier: '#1471', title: '修复 iOS 登录回调', status: 'review', priority: 'high', group: 'pending', state: 'waiting', reason: 'pr_review', blockedBy: null,
    bot: { id: FRONTEND, name: '前端', color: 'orange', shape: 'squircle' }, schedule: null, description: 'iOS 上 Google 登录回来以后停在空白页，修一下。',
    agent: { harness: 'claude_code', model: 'Haiku 5.5' }, place: { kind: 'cloud', name: 'Mikka Cloud' } },
  activity: [
    { kind: 'attempt', runId: '55555555-5555-4555-8555-555555555552', n: 2, group: 'waiting', state: 'done', pullRequest: { number: 1471 }, harness: 'claude_code', createdAt: ago(0, 3), failed: false },
    { kind: 'attempt', runId: '55555555-5555-4555-8555-555555555551', n: 1, group: 'blocked', state: 'failed', harness: 'codex', createdAt: ago(1), failed: true },
    { kind: 'created', by: 'Coordinator', createdAt: ago(1, 1) },
  ],
}
const home = { workspace: { id: WORKSPACE, name: 'Acme Inc.' }, workspaces: [{ id: WORKSPACE, name: 'Acme Inc.' }], bots: [], groups: [], suggestions: 0, live: { workspaceId: WORKSPACE }, preferences: {} }
const session = { session: { id: 'fixture-session', userId: USER, expiresAt: '2099-01-01T00:00:00.000Z', token: 'fixture', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  user: { id: USER, name: '阿宁', email: 'fixture@example.com', emailVerified: true, image: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } }
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })

function apiResponse(url) {
  const { pathname: path, searchParams } = new URL(url)
  if (!path.startsWith('/api/')) return null
  if (path.endsWith('/api/auth/get-session')) return json(session)
  if (path === '/api/version') return json({})
  if (path === '/api/mobile/home') return json(home)
  if (path === '/api/mobile/tasks') return json({ tasks: [] })
  if (path.endsWith('/review/file')) return json(fileDiff(searchParams.get('path')))
  if (path.endsWith('/review')) return json(scenarios[scenarioOf(path)])
  if (path.startsWith('/api/mobile/tasks/')) return json({ ...detail, task: { ...detail.task, ...(scenario === 'before' ? {} : { review: scenarios[scenario]?.summary ?? summary }) } })
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
const settle = page => page.waitForTimeout(500)

async function run() {
  if (!existsSync(join(dist, 'index.html'))) throw new Error(`No Expo Web export at ${dist}`)
  mkdirSync(outDir, { recursive: true })
  const server = await serve(dist, port)
  const origin = `http://127.0.0.1:${port}`
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {})
  const problems = []
  const shot = (page, theme, name) => page.screenshot({ path: join(outDir, `${theme}-${name}.png`) })
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
      scenario = 'before'
      await open(page, origin, `/task/${TASK}`, '活动'); await shot(page, theme, 'r2a-before')
      scenario = 'review'
      await open(page, origin, `/task/${TASK}`, 'PR #1471'); await shot(page, theme, 'r2a-task')
      await page.getByRole('button', { name: /^审阅，/ }).click()
      await page.getByText('批准合并').waitFor({ timeout: 20_000 }); await settle(page); await shot(page, theme, 'r2-review')
      await page.getByRole('button', { name: '1 项检查失败 · 5 项通过' }).click(); await settle(page); await shot(page, theme, 'r2-checks')
      await page.getByText('附到评论').click(); await settle(page)
      await page.getByText('callback.ts', { exact: true }).click()
      await page.getByText("config.authRedirect").first().waitFor({ timeout: 20_000 }); await settle(page)
      await page.getByText("config.authRedirect").first().click()
      await page.getByPlaceholder('写评论').waitFor({ timeout: 20_000 })
      await page.getByPlaceholder('写评论').fill('默认值别写成 /chats，用 config 里已有的 fallback。'); await settle(page); await shot(page, theme, 'r3b-comment')
      await page.getByText('加入评论').click(); await page.getByText('待发送').first().waitFor({ timeout: 20_000 }); await settle(page); await shot(page, theme, 'r3-diff')
      for (const name of ['running', 'merged', 'teammate', 'empty', 'reclaimed']) {
        scenario = name
        await open(page, origin, `/task/${taskOf(name)}/review`, name === 'empty' ? '没有改动' : name === 'running' ? '运行中 · 还没开 PR' : name === 'merged' ? '已合并' : name === 'reclaimed' ? '机器已回收' : '只有任务负责人可以合并')
        await shot(page, theme, `state-${name}`)
      }
      await context.close()
    }
  } finally {
    await browser.close()
    server.close()
  }
  if (problems.length) console.log([...new Set(problems)].join('\n'))
  console.log(`screenshots in ${outDir}`)
}

run().catch(error => { console.error(error); process.exit(1) })
