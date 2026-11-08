// Expo Web screenshots for a task conversation's steps row (Alex 2026-11-08): folded 「已运行 2 条命令 · 调用了 1 个工具 ›」,
// then open to each command and tool call. It renders a real task read from the mobile API, kept outside the
// repository: REAL_TASK_JSON is { tasks, taskId, task, threads } as /api/mobile/tasks, /tasks/:id and /threads/:runId
// return them for the shared test account.
//
//   MOBILE_WEB_DIST=… SCREENSHOT_OUT=… REAL_TASK_JSON=… [SCREENSHOT_SET=before] node apps/mobile/scripts/steps-screenshots.mjs
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { chromium } from '@playwright/test'

const dist = process.env.MOBILE_WEB_DIST || '/tmp/mikka-mobile-web'
const outDir = process.env.SCREENSHOT_OUT || '/tmp/mikka-mobile-steps'
const port = Number(process.env.SCREENSHOT_PORT || 4177)
const before = process.env.SCREENSHOT_SET === 'before'
const real = JSON.parse(readFileSync(process.env.REAL_TASK_JSON, 'utf8'))
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
  if (path === '/api/mobile/tasks') return json({ tasks: real.tasks })
  if (path.startsWith('/api/mobile/tasks/')) return json(real.task)
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
