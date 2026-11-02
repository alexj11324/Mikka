// Flicker/chip repro against the local dev app and the isolated mikka_e2e DB.
// Usage: node .cache/e2e/flicker/repro.mjs <label>
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, rename, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { chromium } from '@playwright/test'
import { acquireTestAccounts } from '../../../scripts/test-accounts/session.mjs'
import { TestAccountPool } from '../../../scripts/test-accounts/pool.mjs'
import { loadEnvironment } from '../../../scripts/test-accounts/environment.mjs'

const label = process.argv[2] ?? 'run'
const out = join('/home/user/Mikka/.cache/e2e/flicker', label)
await mkdir(out, { recursive: true, mode: 0o700 })
const ORIGIN = 'http://localhost:3000'
const db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 })
await new TestAccountPool(db, await loadEnvironment()).prepare({ pairs: 16 })
const scope = await acquireTestAccounts({ database: db, runId: `flicker-${label}-${randomUUID()}`, workerId: 'flicker', requestId: randomUUID(), ttlMs: 300_000 })
const owner = scope.owner.userId
const browser = await chromium.launch({ executablePath: process.env.MIKKA_CHROMIUM_EXECUTABLE_PATH })
const context = await browser.newContext({ storageState: scope.owner.storageStatePath, locale: 'zh-CN', viewport: { width: 1280, height: 860 } })
const page = await context.newPage()
const run = 'wrun_flicker' + randomUUID().replaceAll('-', '').slice(0, 12)
const stored = randomUUID(), live = randomUUID()
try {
  await page.goto(`${ORIGIN}/mikka/zh-CN`, { waitUntil: 'domcontentloaded', timeout: 300_000 })
  const composer = page.getByRole('textbox', { name: '给 Coordinator 发消息', exact: true })
  await composer.waitFor({ timeout: 180_000 })
  // The Coordinator's bot row is created on first access.
  let botId
    for (let i = 0; i < 60 && !botId; i++) {
    botId = (await db.query('SELECT "botId" FROM coordinator_bots WHERE "ownerId"=$1', [owner])).rows[0]?.botId
    if (!botId) await page.waitForTimeout(500)
  }
  if (!botId) throw new Error('no coordinator bot')
  for (const [id, title] of [[stored, '整理发布清单'], [live, '修复登录跳转']]) {
    await db.query(`INSERT INTO issues (id, "userId", title, content, status, priority) VALUES ($1,$2,$3,'{}'::jsonb,'doing','normal')`, [id, owner, title])
  }
  const max = (await db.query('SELECT coalesce(max(position),0) AS p FROM coordinator_messages WHERE "userId"=$1 AND "botId"=$2', [owner, botId])).rows[0].p
  const history = []
  for (let i = 0; i < 4; i++) {
    history.push({ role: 'user', content: `第 ${i + 1} 个问题：现在进度如何？` })
    history.push({ role: 'assistant', content: `正在跟进 [[issue:${stored}]]，第 ${i + 1} 步已经完成。\n\n| 步骤 | 状态 |\n| --- | --- |\n| 构建 | 完成 |\n| 测试 | 进行中 |\n\n下一步会更新 [[issue:${stored}]] 的状态。` })
  }
  // The person's message this streamed reply answers.
  history.push({ role: 'user', content: '两个任务现在怎么样了？' })
  for (const [index, message] of history.entries()) {
    await db.query('INSERT INTO coordinator_messages (id, "userId", "botId", position, message) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), owner, botId, max + index + 1, message])
  }
  await db.query(`INSERT INTO coordinator_sessions ("userId", "botId", "leaseHolder", "leaseUntil") VALUES ($1,$2,$3, now() + interval '10 minutes')
    ON CONFLICT ON CONSTRAINT coordinator_sessions_chat_key DO UPDATE SET "leaseHolder"=EXCLUDED."leaseHolder", "leaseUntil"=EXCLUDED."leaseUntil", "lastError"=NULL`, [owner, botId, run])

  const reply = `好的，我看了一下。[[issue:${stored}]] 已经在构建，[[issue:${live}]] 是刚建的任务，我会同时跟进这两个。构建通过以后再告诉你结果，测试大约还要几分钟。`
  await page.addInitScript(({ run, reply }) => {
    const original = window.fetch
    window.__flicker = { removedChips: 0, minStoredOpacity: 1, rawFrames: [], frames: 0, released: false, committed: false, afterCommitRemovedChips: 0, afterCommitRemovedRows: 0, afterCommitMinOpacity: 1 }
    window.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (!url.includes('/api/coordinator/stream')) return original(input, init)
      const encoder = new TextEncoder()
      const id = `${run}:0`
      const body = new ReadableStream({ async start(controller) {
        const send = event => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
        send({ type: 'start', id })
        // Tokens in uneven batches, as a model sends them.
        let at = 0, n = 0
        while (at < reply.length) {
          const size = [1, 3, 2, 5, 4][n++ % 5]
          send({ type: 'text', id, delta: reply.slice(at, at + size) })
          at += size
          await new Promise(resolve => setTimeout(resolve, 60))
        }
        window.__flicker.released = true
        // Held open until the runner has stored the reply, then committed as the workflow does.
        const through = await new Promise(resolve => { window.__commit = resolve })
        window.__flicker.committed = true
        send({ type: 'committed', id, through, quiet: false })
        controller.close()
      } })
      return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
    }
    const removed = node => node.nodeType === 1 && (node.matches?.('[data-slot="inline-citation-trigger"]') ? 1 : node.querySelectorAll?.('[data-slot="inline-citation-trigger"]').length ?? 0)
    new MutationObserver(records => {
      for (const record of records) for (const node of record.removedNodes) {
        if (window.__flicker.committed) {
          window.__flicker.afterCommitRemovedChips += removed(node)
          if (node.nodeType === 1 && node.matches?.('[data-message-id]')) window.__flicker.afterCommitRemovedRows++
        } else if (record.target.isConnected && !record.target.closest?.('[data-coordinator-stream-id]')) window.__flicker.removedChips += removed(node)
      }
    }).observe(document, { subtree: true, childList: true })
    const tick = () => {
      if (window.__flicker.committed) for (const chip of document.querySelectorAll('[data-message-id] [data-slot="inline-citation-trigger"]')) {
        window.__flicker.afterCommitMinOpacity = Math.min(window.__flicker.afterCommitMinOpacity, Number(getComputedStyle(chip).opacity))
      }
      const live = document.querySelector('[data-coordinator-stream-id]')
      if (live) {
        window.__flicker.frames++
        for (const chip of document.querySelectorAll('[data-message-id] [data-slot="inline-citation-trigger"]')) {
          if (chip.closest('[data-coordinator-stream-id]')) continue
          window.__flicker.minStoredOpacity = Math.min(window.__flicker.minStoredOpacity, Number(getComputedStyle(chip).opacity))
        }
        const text = live.textContent ?? ''
        const raw = /\[\[|issue:|run:|[0-9a-f]{8}-[0-9a-f]{4}/.exec(text)
        if (raw && window.__flicker.rawFrames.length < 40) window.__flicker.rawFrames.push(text.slice(Math.max(0, raw.index - 10), raw.index + 30))
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, { run, reply })
  const cdp = await context.newCDPSession(page)
  await mkdir(join(out, 'cast'), { recursive: true })
  let castIndex = 0
  const castWrites = []
  cdp.on('Page.screencastFrame', frame => {
    castWrites.push(writeFile(join(out, 'cast', `${String(castIndex++).padStart(4, '0')}.jpg`), Buffer.from(frame.data, 'base64')))
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
  })
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 180_000 })
  await page.locator('[data-coordinator-stream-id]').waitFor({ timeout: 60_000 })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 })
  const frames = []
  await page.waitForFunction(() => window.__flicker.released, null, { timeout: 120_000 })
  const releasedAt = Date.now()
  const resolved = await page.locator('[data-coordinator-stream-id] [data-slot="inline-citation-trigger"]').nth(1).waitFor({ timeout: 30_000 }).then(() => Date.now() - releasedAt, () => null)
  await page.waitForTimeout(800)
  const finalText = await page.locator('[data-coordinator-stream-id]').textContent()
  const finalChips = await page.locator('[data-coordinator-stream-id] [data-slot="inline-citation-trigger"]').count()
  await writeFile(join(out, 'streaming-end.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  // Handoff: store the reply as the workflow does (with its stream id), end the turn, then commit the stream.
  await page.evaluate(() => { document.querySelector('[data-coordinator-stream-id]').__flickerMark = true })
  const position = (await db.query('SELECT coalesce(max(position),0)+1 AS p FROM coordinator_messages WHERE "userId"=$1 AND "botId"=$2', [owner, botId])).rows[0].p
  await db.query('INSERT INTO coordinator_messages (id, "userId", "botId", position, message) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), owner, botId, position, { role: 'assistant', content: reply, mikkaStreamId: `${run}:0` }])
  await db.query('UPDATE coordinator_sessions SET "leaseHolder"=NULL, "leaseUntil"=NULL WHERE "userId"=$1 AND "botId"=$2', [owner, botId])
  const commitFrame = castIndex
  await page.evaluate(through => window.__commit(through), position)
  const handedOver = await page.waitForFunction(() => !document.querySelector('[data-coordinator-stream-id]') && [...document.querySelectorAll('[data-message-id]')].some(row => row.textContent.includes('测试大约还要几分钟')), null, { timeout: 60_000 }).then(() => true, () => false)
  await page.waitForTimeout(1500)
  const sameRow = await page.evaluate(() => [...document.querySelectorAll('[data-message-id]')].find(row => row.textContent.includes('测试大约还要几分钟'))?.__flickerMark === true)
  const storedChips = await page.locator('[data-message-id]').filter({ hasText: '测试大约还要几分钟' }).locator('[data-slot="inline-citation-trigger"]').count()
  await writeFile(join(out, 'stored.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  await cdp.send('Page.stopScreencast').catch(() => {})
  await Promise.all(castWrites)
  const metrics = await page.evaluate(() => window.__flicker)
  const result = { label, revision: process.env.FLICKER_REVISION ?? null, origin: ORIGIN, database: 'mikka_e2e (127.0.0.1, isolated)', run, at: new Date().toISOString(), metrics, finalChips, newChipResolvedMsAfterStreamEnd: resolved, finalTextHasRaw: /\[\[|issue:|[0-9a-f]{8}-[0-9a-f]{4}/.test(finalText ?? ''), castFrames: castIndex, handoff: { commitFrame, handedOver, sameRow, storedChips } }
  await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  await db.query('UPDATE coordinator_sessions SET "leaseHolder"=NULL, "leaseUntil"=NULL WHERE "userId"=$1', [owner]).catch(() => {})
  await context.close()
  await browser.close()
  await scope.release({ outcome: 'clean' }).catch(() => {})
  await db.end()
}
