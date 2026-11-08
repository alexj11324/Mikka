// Expo Web screenshots for the iOS chat batch (Alex 2026-11-08): the glass title pill, time separators, ⋯ under each
// message, a long press selecting words with 「添加到对话」, and ⋯'s actions. Our own labelled fixtures.
//
//   MOBILE_WEB_DIST=/path/to/expo-web-export SCREENSHOT_OUT=/path/to/out [SCREENSHOT_SET=before] node apps/mobile/scripts/chat-screenshots.mjs
//
// SCREENSHOT_SET=before shoots only the chat as it was (an export of main), for the before/after pair.
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { chromium } from '@playwright/test'

const dist = process.env.MOBILE_WEB_DIST || '/tmp/mikka-mobile-web'
const outDir = process.env.SCREENSHOT_OUT || '/tmp/mikka-mobile-chat'
const port = Number(process.env.SCREENSHOT_PORT || 4176)
const before = process.env.SCREENSHOT_SET === 'before'

const USER = '11111111-1111-4111-8111-111111111111'
const WORKSPACE = '22222222-2222-4222-8222-222222222222'
const BOT = '33333333-3333-4333-8333-333333333334'
const day = new Date(); day.setHours(0, 0, 0, 0)
/** A time `days` before today at hh:mm, local. */
const at = (days, hh, mm) => new Date(day.getTime() - days * 86_400_000 + (hh * 60 + mm) * 60_000).toISOString()

let position = 0
const person = (text, createdAt) => ({ id: `m${++position}`, position, from: 'person', text, threads: [], artifacts: [], createdAt })
const bot = (text, createdAt) => ({ id: `m${++position}`, position, from: 'coordinator', text, threads: [], artifacts: [], createdAt })
const items = [
  person('帮我看一下 iOS 登录回调为什么停在空白页', at(1, 21, 4)),
  bot('回调地址少了 mikka:// 的信任来源。加上以后，模拟器里登录能回到聊天列表。', at(1, 21, 6)),
  person('那 Android 呢？', at(0, 9, 21)),
  bot('Android 的 intent filter 也要加同样的 scheme，我已经一起改了。', at(0, 9, 23)),
  person('好，今天发一版 TestFlight', at(0, 9, 47)),
  bot('收到。构建排上了，大约二十分钟后能装。装好以后先试一下 Google 登录，再试一下退出重登。', at(0, 9, 48)),
]
const chat = { botId: BOT, enabled: true, working: false, error: null, artifacts: {}, failure: null, live: { workspaceId: WORKSPACE }, items, sources: {},
  reactions: { m2: [{ emoji: '👍', count: 1, mine: true }] } }
const haiku = { id: 'b-claude', modelId: 'claude-haiku-5-5', provider: 'claude' }
const modelMenu = { groups: [{ kind: 'subscription', provider: 'claude', plan: 'Max', options: [haiku] }], current: { ...haiku, kind: 'subscription', chosen: true, available: true } }
const home = { user: { id: USER, name: '阿宁', email: 'fixture@example.com', image: null }, workspace: { id: WORKSPACE, name: '个人' }, workspaces: [{ id: WORKSPACE, name: '个人' }],
  bots: [{ id: BOT, name: 'iOS 助手', color: 'bleu', shape: 'nuage', line: '收到。构建排上了', at: at(0, 9, 48) }], groups: [], suggestions: 0, live: { workspaceId: WORKSPACE }, preferences: {} }
const session = { session: { id: 'fixture-session', userId: USER, expiresAt: '2099-01-01T00:00:00.000Z', token: 'fixture', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  user: { id: USER, name: '阿宁', email: 'fixture@example.com', emailVerified: true, image: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } }
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })

function apiResponse(url) {
  const { pathname: path } = new URL(url)
  if (!path.startsWith('/api/')) return null
  if (path.endsWith('/api/auth/get-session')) return json(session)
  if (path === '/api/version') return json({})
  if (path === '/api/mobile/home') return json(home)
  if (path === '/api/mobile/tasks') return json({ tasks: [] })
  if (path === '/api/mobile/chat') return json(chat)
  if (path === '/api/mobile/model') return json(modelMenu)
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

/** A long press, as a finger resting on the bubble past the 500 ms hold. */
async function longPress(page, locator) {
  const box = await locator.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down(); await page.waitForTimeout(800); await page.mouse.up()
}

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
      const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, colorScheme: theme, locale: 'zh-CN' })
      const page = await context.newPage()
      page.on('pageerror', error => problems.push(`${theme}: ${error}`))
      await page.route('**/*', async route => {
        const url = route.request().url()
        const hit = url.startsWith(origin) ? apiResponse(url) : null
        if (!hit && url.startsWith(`${origin}/api/`)) problems.push(`${theme}: unanswered ${new URL(url).pathname}`)
        return hit ? route.fulfill(hit) : route.continue()
      })
      await open(page, origin, `/bots/${BOT}`, '构建排上了')
      if (before) { await shot(page, theme, 'chat-before'); await context.close(); continue }
      await shot(page, theme, 'chat')
      // Part way up: messages dissolve under the title pill rather than being cut at the bar.
      await page.mouse.move(196, 400); await page.mouse.wheel(0, -50); await settle(page)
      await shot(page, theme, 'chat-edge')
      await page.mouse.wheel(0, 3000); await settle(page)
      // The top of the chat: 「昨天 21:04」 above yesterday's pair, 「09:21」 above today's.
      await page.mouse.move(196, 400); await page.mouse.wheel(0, -3000); await settle(page)
      await shot(page, theme, 'chat-top')
      await page.mouse.wheel(0, 3000); await settle(page)
      // A long press on the bot's latest reply selects its words; 「添加到对话」 leads the capsules above the composer.
      await longPress(page, page.getByText('构建排上了').first())
      await page.getByRole('button', { name: '添加到对话' }).waitFor({ timeout: 20_000 }); await settle(page)
      await shot(page, theme, 'select')
      await page.getByRole('button', { name: '添加到对话' }).click(); await settle(page)
      await shot(page, theme, 'quoted')
      // ⋯ under a message: its reactions, 回复, 复制 and 选择文本 (the system menu on iOS, this sheet on the web build).
      await page.getByRole('button', { name: '更多', exact: true }).nth(1).click()
      await page.getByText('选择文本').first().waitFor({ timeout: 20_000 }); await settle(page)
      await shot(page, theme, 'more')
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
