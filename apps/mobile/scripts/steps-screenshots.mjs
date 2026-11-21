// Expo Web screenshots for a task conversation's steps row (Alex 2026-11-08): folded 「已运行 2 条命令 · 调用了 1 个工具 ›」,
// then open to each command and tool call. Our own labelled fixture; REAL_TASK_JSON ({ tasks, taskId, task, threads }
// as /api/mobile/tasks, /tasks/:id and /threads/:runId return them) renders a real read for a local check only.
//
//   MOBILE_WEB_DIST=… SCREENSHOT_OUT=… [SCREENSHOT_SET=before] [REAL_TASK_JSON=…] node apps/mobile/scripts/steps-screenshots.mjs
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { chromium } from '@playwright/test'

const dist = process.env.MOBILE_WEB_DIST || '/tmp/mikka-mobile-web'
const outDir = process.env.SCREENSHOT_OUT || '/tmp/mikka-mobile-steps'
const port = Number(process.env.SCREENSHOT_PORT || 4177)
const before = process.env.SCREENSHOT_SET === 'before'
const RUN = '55555555-5555-4555-8555-555555555561'
const TASK = '44444444-4444-4444-8444-444444444481'
const ago = minutes => new Date(Date.now() - minutes * 60_000).toISOString()
const at = minutes => Date.now() - minutes * 60_000
/** Our own labelled fixture, shaped as the mobile thread read sends steps (id, name, detail, failed). */
const fixture = {
  tasks: [{ id: TASK, identifier: '#1481', title: '修复登录回调的验收脚本', status: 'doing', priority: 'normal', group: 'running', state: 'running', reason: null, owner: '测试', updatedAt: ago(5), createdAt: ago(90), blocked: null, schedule: null, bot: null }],
  taskId: TASK,
  task: { task: { id: TASK, identifier: '#1481', title: '修复登录回调的验收脚本', status: 'doing', priority: 'normal', group: 'running', state: 'running', reason: null, blockedBy: null, bot: null, schedule: null, description: '', agent: { harness: 'codex', model: 'GPT-6 Luna' }, place: { kind: 'cloud', name: 'Mikka Cloud' } },
    activity: [{ kind: 'attempt', runId: RUN, n: 1, group: 'done', state: 'done', harness: 'codex', createdAt: ago(60), failed: false }, { kind: 'created', by: 'Coordinator', createdAt: ago(90) }] },
  threads: { [RUN]: { live: { runs: [] }, active: false, working: false, paused: null, summary: null, error: null,
    thread: { id: RUN, name: '修复登录回调的验收脚本', status: 'done', by: '前端', harness: 'codex', device: { id: 'd', name: 'Mikka Cloud', kind: 'cloud' }, createdAt: ago(60), finishedAt: ago(5), group: 'done', attempts: 1 },
    items: [
      { kind: 'agent', id: 'a1', text: '先跑一遍现有的验收脚本，看回调停在哪一步。', at: at(58) },
      { kind: 'steps', id: 's1', count: 3, at: at(57), steps: [
        { id: 't1', name: 'bash', detail: '/bin/bash -lc "pnpm test:mobile -- --test-name-pattern callback"', failed: true },
        { id: 't2', name: 'bash', detail: '/bin/bash -lc "rg -n authRedirect apps/mobile/lib"', failed: false },
        { id: 't3', name: 'apply_patch', detail: '/workspace/apps/mobile/lib/auth/callback.ts', failed: false },
      ] },
      { kind: 'agent', id: 'a2', text: '回调地址少了信任来源，已经补上。再跑一次测试，并把结论记下来。', at: at(40) },
      { kind: 'steps', id: 's2', count: 2, at: at(39), steps: [
        { id: 't4', name: 'bash', detail: '/bin/bash -lc "pnpm test:mobile -- --test-name-pattern callback"', failed: false },
        { id: 't5', name: 'mcp__mikka__record_decision', detail: '回调改用 config.authRedirect', failed: false },
      ] },
      { kind: 'agent', id: 'a3', text: '测试通过，结论已记录。', at: at(6) },
    ] } },
}
// REAL_TASK_JSON renders a task read from the mobile API instead, for a local check only: never commit those frames.
const real = process.env.REAL_TASK_JSON ? JSON.parse(readFileSync(process.env.REAL_TASK_JSON, 'utf8')) : fixture
const USER = '11111111-1111-4111-8111-111111111111'
const WORKSPACE = '22222222-2222-4222-8222-222222222222'
const home = { user: { id: USER, name: '测试', email: 'fixture@example.com', image: null }, workspace: { id: WORKSPACE, name: '团队' }, workspaces: [{ id: WORKSPACE, name: '团队' }], bots: [], groups: [], suggestions: 0, live: { workspaceId: WORKSPACE }, preferences: {} }
const session = { session: { id: 'fixture-session', userId: USER, expiresAt: '2099-01-01T00:00:00.000Z', token: 'fixture', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  user: { id: USER, name: '测试', email: 'fixture@example.com', emailVerified: true, image: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } }
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })

function apiResponse(url) {
  const { pathname: path } = new URL(url)
  if (!path.startsWith('/api/')) return null
  if (path.endsWith('/api/auth/get-session')) return json(session)
  if (path === '/api/version') return json({})
  if (path === '/api/mobile/home') return json(home)
  if (path === '/api/mobile/task-presentations') return json({ version: 1, workspaceId: WORKSPACE, items: Object.fromEntries(real.tasks.map(task =>
    [task.id, { version: 1, state: task.state, group: task.group, reason: task.reason, blockedBy: task.blockedBy ?? null, primaryStatus: task.status }])) })
  if (path === '/api/mobile/tasks') return json({ workspaceId: WORKSPACE, tasks: real.tasks })
  if (path.startsWith('/api/mobile/tasks/')) return json({ ...real.task, live: { workspaceId: WORKSPACE } })
  if (path.startsWith('/api/mobile/threads/')) return json(real.threads[path.split('/').pop()] ?? Object.values(real.threads)[0])
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
  await page.waitForTimeout(600)
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
  const firstRun = Object.keys(real.threads).find(id => real.threads[id].items.some(item => item.kind === 'steps'))
  try {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, colorScheme: theme, locale: 'zh-CN' })
      const page = await context.newPage()
      page.on('pageerror', error => problems.push(`${theme}: ${error}`))
      await page.route('**/*', async route => {
        const url = route.request().url()
        const hit = url.startsWith(origin) ? apiResponse(url) : null
        if (!hit && url.startsWith(`${origin}/api/`)) problems.push(`${theme}: unanswered ${new URL(url).pathname}`)
        return hit ? route.fulfill(hit) : route.continue()
      })
      await open(page, origin, `/thread/${firstRun}`, before ? real.threads[firstRun].thread.name : '条命令')
      await shot(page, theme, before ? 'thread-before' : 'thread')
      if (!before) {
        await page.getByText(/已运行 \d+ 条命令/).first().click(); await settle(page)
        await shot(page, theme, 'thread-open')
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
