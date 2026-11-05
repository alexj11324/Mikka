// Expo Web screenshots for the Phase 3 chat screen (#1408).
// Our own fixture and script. No OpenBot source or wording.
//
//   node scripts/mobile-chat-parity-screenshots.mjs
//
// Exports apps/mobile for web (unless MOBILE_WEB_DIST already has index.html),
// serves that bundle, and answers its API with labeled fixtures. Writes
// light and dark frames at 375 / 393 / 430 into SCREENSHOT_OUT
// (default /opt/cursor/artifacts/mobile-chat-parity).
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { extname, join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { chromium } from '@playwright/test'

const root = new URL('..', import.meta.url).pathname
const dist = process.env.MOBILE_WEB_DIST || '/tmp/mikka-mobile-web'
const outDir = process.env.SCREENSHOT_OUT || '/opt/cursor/artifacts/mobile-chat-parity'
const chrome = process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/local/bin/google-chrome'
const port = Number(process.env.SCREENSHOT_PORT || 4173)

const USER = '11111111-1111-4111-8111-111111111111'
const WORKSPACE = '22222222-2222-4222-8222-222222222222'
const BOT = '33333333-3333-4333-8333-333333333333'
const HOSTED = '00000000-0000-0000-0000-000000000000'

const WIDTHS = [
  [375, 812],
  [393, 852],
  [430, 932],
]

const SHOTS = ['home', 'title-menu', 'queue', 'attachment', 'viewer', 'grid', 'paging', 'actions', 'selection']

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([length, body, crc])
}

function png(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 3
      const band = Math.floor((x / width) * 48)
      raw[i] = Math.min(255, rgb[0] + band)
      raw[i + 1] = rgb[1]
      raw[i + 2] = rgb[2]
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const PICTURES = [
  png(800, 600, [36, 99, 196]),
  png(600, 800, [32, 150, 96]),
  png(800, 800, [214, 112, 36]),
  png(900, 520, [124, 72, 186]),
]

const ago = (ms) => new Date(Date.now() - ms).toISOString()

function thread(id, name, status, group) {
  return { id, name, status, group, by: '周报', harness: 'claude', device: null, createdAt: ago(3_600_000), finishedAt: null }
}

const botPage = {
  threads: [
    thread('thread-waiting', '整理本周进展', 'waiting', 'waiting'),
    thread('thread-running', '核对发票差额', 'running', 'running'),
    thread('thread-done', '上周周报', 'done', 'resolved'),
  ],
  pullRequests: [],
  schedules: [],
  library: [],
  pinned: false,
  muted: false,
}

const modelMenu = {
  groups: [{ kind: 'hosted', points: 20, options: [{ id: HOSTED, modelId: '', provider: 'mikka' }] }],
  current: { id: HOSTED, modelId: '', provider: 'mikka', kind: 'hosted', chosen: true, available: true },
}

function item(position, from, text, extra = {}) {
  return { position, from, text, threads: [], artifacts: [], createdAt: ago(60_000 * (8 - position)), ...extra }
}

function chat(kind) {
  const talk = [
    item(1, 'coordinator', '周报我按这三块写：进展、阻塞、下周。', { id: 'msg-1' }),
    item(2, 'person', '阻塞写具体一点。', { id: 'msg-2' }),
    item(3, 'coordinator', '阻塞是发票还没对上，我先列差额。', { id: 'msg-3' }),
  ]
  if (kind === 'viewer') talk.push(item(4, 'person', '这张。', { id: 'msg-one', images: 1 }))
  if (kind === 'grid' || kind === 'paging') talk.push(item(4, 'person', '这四张。', { id: 'msg-four', images: 4 }))
  const queued = kind === 'queue'
  if (queued) {
    talk.push(item(4, 'person', '先把差额表发我', { pending: true, createdAt: ago(30_000) }))
    talk.push(item(5, 'person', '再补上负责人', { pending: true, createdAt: ago(20_000) }))
    talk.push(item(6, 'person', '然后约个核对会', { pending: true, createdAt: ago(10_000) }))
  }
  return {
    botId: BOT,
    enabled: true,
    working: queued,
    error: null,
    failure: null,
    items: talk,
    sources: {},
    artifacts: {},
    reactions: {},
    live: { ownerId: USER, workspaceId: WORKSPACE },
    historyBefore: null,
  }
}

function home(kind) {
  return {
    user: { id: USER, name: '阿宁', email: 'fixture@example.com', image: null },
    workspace: { id: WORKSPACE, name: '个人' },
    workspaces: [{ id: WORKSPACE, name: '个人' }],
    bots: [{ id: BOT, name: '周报', color: '#3B82F6', shape: 'circle', line: '阻塞是发票还没对上，我先列差额。', at: ago(60_000), working: kind === 'queue' }],
    threads: { running: 1, waiting: 1 },
    suggestions: 0,
    live: { ownerId: USER, workspaceId: WORKSPACE },
  }
}

const session = {
  session: {
    id: 'sess-fixture',
    userId: USER,
    token: 'fixture',
    expiresAt: '2099-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  user: {
    id: USER,
    name: '阿宁',
    email: 'fixture@example.com',
    emailVerified: true,
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
}

function json(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

function apiResponse(url, kind) {
  const path = new URL(url).pathname
  if (path.endsWith('/api/auth/get-session')) return json(session)
  if (path === '/api/version') return json({})
  if (path === '/api/mobile/home') return json(home(kind))
  if (path === '/api/mobile/chat/image') {
    const index = Number(new URL(url).searchParams.get('index') || 0)
    return { status: 200, contentType: 'image/png', body: PICTURES[index] ?? PICTURES[0] }
  }
  if (path === '/api/mobile/chat') return json(chat(kind))
  if (path.startsWith('/api/mobile/bots/')) return json(botPage)
  if (path === '/api/mobile/model') return json(modelMenu)
  if (path === '/api/pending-actions') return json([])
  if (path.startsWith('/api/live/')) return json({ error: 'offline' }, 404)
  return null
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
}

function serve(directory, listenPort) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      const pathname = decodeURIComponent(url.pathname)
      if (pathname.includes('..')) {
        response.writeHead(400)
        response.end()
        return
      }
      let file = join(directory, pathname)
      const missing = !existsSync(file) || statSync(file).isDirectory()
      if (missing) {
        if (extname(pathname)) {
          response.writeHead(404)
          response.end()
          return
        }
        file = join(directory, 'index.html')
      }
      response.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
      createReadStream(file).pipe(response)
    })
    server.listen(listenPort, '127.0.0.1', () => resolve(server))
  })
}

function exportWeb() {
  if (existsSync(join(dist, 'index.html')) && process.env.REEXPORT !== '1') {
    console.log(`reusing ${dist}`)
    return Promise.resolve()
  }
  mkdirSync(dist, { recursive: true })
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'expo', 'export', '--platform', 'web', '--output-dir', dist], {
      cwd: join(root, 'apps/mobile'),
      stdio: 'inherit',
      env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1' },
    })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`expo export exited ${code}`))))
  })
}

async function openChat(page, origin, kind) {
  const missed = []
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => undefined)
  await page.route('**/*', async (route) => {
    const url = route.request().url()
    if (!url.startsWith(origin)) return route.continue()
    const hit = apiResponse(url, kind)
    if (!hit) {
      const path = new URL(url).pathname
      if (path.startsWith('/api/')) missed.push(`${route.request().method()} ${path}`)
      return route.continue()
    }
    await route.fulfill(hit)
  })
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`${origin}/bots/${BOT}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.getByRole('button', { name: '周报' }).waitFor({ timeout: 20_000 })
  await page.getByText('阻塞是发票还没对上，我先列差额。').first().waitFor({ timeout: 20_000 })
  await page.evaluate(() => document.fonts.ready)
  return { missed, errors }
}

async function settle(page) {
  await page.waitForTimeout(450)
  await page.evaluate(() => document.fonts.ready)
}

async function capture(page, file) {
  await settle(page)
  await page.screenshot({ path: file })
}

async function run() {
  await exportWeb()
  mkdirSync(outDir, { recursive: true })
  const server = await serve(dist, port)
  const origin = `http://127.0.0.1:${port}`
  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const manifest = []
  try {
    const only = process.env.SHOT_ONLY
    for (const theme of ['light', 'dark']) {
      for (const [width, height] of WIDTHS) {
        if (only && `${theme}-${width}` !== only) continue
        const context = await browser.newContext({
          viewport: { width, height },
          deviceScaleFactor: 2,
          colorScheme: theme,
          hasTouch: true,
          isMobile: true,
          locale: 'zh-CN',
        })
        const page = await context.newPage()
        const tag = `${theme}-${width}`
        try {
          const debug = await openChat(page, origin, 'home')
          await capture(page, join(outDir, `${tag}-home.png`))
          manifest.push(`${tag}-home`)

          await page.getByRole('button', { name: '周报' }).click()
          await page.getByRole('button', { name: '资料' }).waitFor({ timeout: 10_000 })
          await capture(page, join(outDir, `${tag}-title-menu.png`))
          manifest.push(`${tag}-title-menu`)

          await page.goto('about:blank')
          await openChat(page, origin, 'queue')
          await page.getByRole('button', { name: '还有 2 条排队消息' }).click()
          await page.getByText('然后约个核对会').waitFor({ timeout: 10_000 })
          await capture(page, join(outDir, `${tag}-queue.png`))
          manifest.push(`${tag}-queue`)

          await page.goto('about:blank')
          await openChat(page, origin, 'home')
          await page.getByRole('button', { name: '添加' }).click()
          await page.getByRole('button', { name: '相机' }).waitFor({ timeout: 10_000 })
          await capture(page, join(outDir, `${tag}-attachment.png`))
          manifest.push(`${tag}-attachment`)

          await page.goto('about:blank')
          await openChat(page, origin, 'viewer')
          await page.getByLabel('图片').click()
          await page.getByRole('button', { name: '分享' }).waitFor({ timeout: 10_000 })
          await page.waitForTimeout(700)
          await capture(page, join(outDir, `${tag}-viewer.png`))
          manifest.push(`${tag}-viewer`)

          await page.goto('about:blank')
          await openChat(page, origin, 'grid')
          await page.getByRole('button', { name: '查看全部 4 张图片' }).click()
          await page.getByRole('heading', { name: '4 张图片' }).waitFor({ timeout: 10_000 })
          await capture(page, join(outDir, `${tag}-grid.png`))
          manifest.push(`${tag}-grid`)

          await page.getByRole('button', { name: '第 2 张' }).click()
          await page.getByText('2 / 4').waitFor({ timeout: 10_000 })
          await capture(page, join(outDir, `${tag}-paging.png`))
          manifest.push(`${tag}-paging`)

          await page.goto('about:blank')
          await openChat(page, origin, 'home')
          await page.getByRole('button', { name: '更多' }).click()
          await page.getByRole('button', { name: '选择文本' }).waitFor({ timeout: 10_000 })
          await capture(page, join(outDir, `${tag}-actions.png`))
          manifest.push(`${tag}-actions`)

          await page.getByRole('button', { name: '选择文本' }).click()
          await page.getByRole('button', { name: '解释' }).waitFor({ timeout: 10_000 })
          await capture(page, join(outDir, `${tag}-selection.png`))
          manifest.push(`${tag}-selection`)

          if (debug.missed.length || debug.errors.length) {
            console.log(tag, { missed: debug.missed, errors: debug.errors.slice(0, 4) })
          }
        } catch (error) {
          const fail = join(outDir, `${tag}-failed.png`)
          await page.screenshot({ path: fail }).catch(() => undefined)
          const text = await page.locator('body').innerText().catch(() => '')
          writeFileSync(join(outDir, `${tag}-failed.txt`), `${error}\n\n${text.slice(0, 4000)}`)
          throw error
        } finally {
          await context.close()
        }
      }
    }
  } finally {
    await browser.close()
    server.close()
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ shots: SHOTS, files: manifest }, null, 2))
  console.log(JSON.stringify({ screenshots: manifest.length, outDir }))
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
