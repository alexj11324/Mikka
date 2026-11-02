// Live thinking and tool activity in the Bot chat, against a local production build and the isolated mikka_e2e DB.
// Usage: node .cache/e2e/flicker/repro-activity.mjs <label>
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { chromium } from '@playwright/test'
import { acquireTestAccounts } from '../../../scripts/test-accounts/session.mjs'
import { TestAccountPool } from '../../../scripts/test-accounts/pool.mjs'
import { loadEnvironment } from '../../../scripts/test-accounts/environment.mjs'

const label = process.argv[2] ?? 'activity'
const out = join('/home/user/Mikka/.cache/e2e/flicker', label)
await mkdir(join(out, 'cast'), { recursive: true, mode: 0o700 })
const ORIGIN = 'http://localhost:3000'
const db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 })
await new TestAccountPool(db, await loadEnvironment()).prepare({ pairs: 24 })
const scope = await acquireTestAccounts({ database: db, runId: `activity-${label}-${randomUUID()}`, workerId: 'activity', requestId: randomUUID(), ttlMs: 300_000 })
const owner = scope.owner.userId
const browser = await chromium.launch({ executablePath: process.env.MIKKA_CHROMIUM_EXECUTABLE_PATH })
const context = await browser.newContext({ storageState: scope.owner.storageStatePath, locale: 'zh-CN', viewport: { width: 1280, height: 860 } })
const page = await context.newPage()
const run = 'wrun_activity' + randomUUID().replaceAll('-', '').slice(0, 12)
const issue = randomUUID()
const shots = {}
// REASONING=text: the model returns readable reasoning; REASONING=none: encrypted reasoning, no text.
const readable = (process.env.REASONING ?? 'text') === 'text'
const thoughtText = '登录后跳回首页，多半是登录回调没带上原来的地址。先建个任务记下来，再派到云端去查回调参数。'
try {
  await page.goto(`${ORIGIN}/mikka/zh-CN`, { waitUntil: 'domcontentloaded', timeout: 300_000 })
  await page.getByRole('textbox', { name: '给 Coordinator 发消息', exact: true }).waitFor({ timeout: 180_000 })
  let botId
  for (let i = 0; i < 60 && !botId; i++) {
    botId = (await db.query('SELECT "botId" FROM coordinator_bots WHERE "ownerId"=$1', [owner])).rows[0]?.botId
    if (!botId) await page.waitForTimeout(500)
  }
  await db.query(`INSERT INTO issues (id, "userId", title, content, status, priority) VALUES ($1,$2,'修复登录跳转','{}'::jsonb,'todo','normal')`, [issue, owner])
  const max = (await db.query('SELECT coalesce(max(position),0) AS p FROM coordinator_messages WHERE "userId"=$1 AND "botId"=$2', [owner, botId])).rows[0].p
  await db.query('INSERT INTO coordinator_messages (id, "userId", "botId", position, message) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), owner, botId, max + 1, { role: 'user', content: '登录后会跳回首页，帮我建个任务查一下' }])
  await db.query(`INSERT INTO coordinator_sessions ("userId", "botId", "leaseHolder", "leaseUntil") VALUES ($1,$2,$3, now() + interval '10 minutes')
    ON CONFLICT ON CONSTRAINT coordinator_sessions_chat_key DO UPDATE SET "leaseHolder"=EXCLUDED."leaseHolder", "leaseUntil"=EXCLUDED."leaseUntil", "lastError"=NULL`, [owner, botId, run])

  const reply = `建好了 [[issue:${issue}]]，已派到云端（E2B）开始做。日历暂时读不到，开会时间我稍后再看。`
  // The events the server sends for this turn, with the pauses between them (ms).
  const script = [
    [{ type: 'thinking', state: 'start' }, 2600], [{ type: 'thinking', state: 'end', ...(readable ? { text: thoughtText } : {}) }, 300],
    [{ type: 'tool', call: 'c1', name: 'create_issue', state: 'running', input: '{"title":"修复登录跳转","description":"登录后会跳回首页"}' }, 1800],
    [{ type: 'tool', call: 'c1', name: 'create_issue', state: 'done', output: `{"id":"${issue}","identifier":"MIK-12"}` }, 300],
    [{ type: 'tool', call: 'c2', name: 'dispatch_run', state: 'running', input: `{"issueId":"${issue}"}` }, 1800],
    [{ type: 'tool', call: 'c2', name: 'dispatch_run', state: 'done', output: '{"runId":"r1","status":"queued","place":"cloud"}' }, 300],
    [{ type: 'tool', call: 'c3', name: 'list_calendar_events', state: 'running', input: '{"days":1}' }, 1500],
    [{ type: 'tool', call: 'c3', name: 'list_calendar_events', state: 'error', output: 'Google Calendar 未连接' }, 300],
  ]
  await page.addInitScript(({ run, reply, script }) => {
    const original = window.fetch
    window.__activity = { phase: 'idle' }
    window.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (!url.includes('/api/coordinator/stream')) return original(input, init)
      const encoder = new TextEncoder()
      const id = `${run}:0`
      const body = new ReadableStream({ async start(controller) {
        const send = event => controller.enqueue(encoder.encode(JSON.stringify({ ...event, id }) + '\n'))
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
        send({ type: 'start' })
        await new Promise(resolve => { window.__go = resolve })
        for (const [event, pause] of script) { send(event); window.__activity.phase = `${event.type}:${event.call ?? ''}:${event.state}`; await wait(pause) }
        for (let at = 0, n = 0; at < reply.length; n++) { const size = [2, 3, 1, 4][n % 4]; send({ type: 'text', delta: reply.slice(at, at + size) }); at += size; await wait(60) }
        window.__activity.phase = 'text-done'
        const through = await new Promise(resolve => { window.__commit = resolve })
        send({ type: 'committed', through, quiet: false })
        controller.close()
      } })
      return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
    }
  }, { run, reply, script: script.map(([event, pause]) => [event.type === 'thinking' && event.state === 'end' && readable ? { ...event, text: thoughtText } : event, pause]) })
  const cdp = await context.newCDPSession(page)
  let castIndex = 0
  const castWrites = []
  cdp.on('Page.screencastFrame', frame => {
    castWrites.push(writeFile(join(out, 'cast', `${String(castIndex++).padStart(4, '0')}.jpg`), Buffer.from(frame.data, 'base64')))
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
  })
  const shot = async name => { await writeFile(join(out, `${name}.png`), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 324, y: 0, width: 580, height: 860, scale: 1 } })).data, 'base64')); shots[name] = castIndex }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 180_000 })
  await page.getByRole('textbox', { name: '给 Coordinator 发消息', exact: true }).waitFor({ timeout: 120_000 })
  await page.waitForFunction(() => typeof window.__go === 'function', null, { timeout: 60_000 })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 75, everyNthFrame: 1 })
  await page.waitForTimeout(1200)
  await shot('0-waiting')
  await page.evaluate(() => window.__go())
  await page.waitForFunction(() => window.__activity.phase === 'thinking::start'); await page.waitForTimeout(900); await shot('1-thinking')
  await page.waitForFunction(() => window.__activity.phase === 'tool:c1:running'); await page.waitForTimeout(700); await shot('2-tool-running')
  if (readable) {
    await page.locator('[data-coordinator-stream-id] [data-activity-thinking] button').click(); await page.waitForTimeout(600); await shot('2b-reasoning-open-live')
    await page.locator('[data-coordinator-stream-id] [data-activity-thinking] button').click()
  }
  await page.waitForFunction(() => window.__activity.phase === 'tool:c2:running'); await page.waitForTimeout(700); await shot('3-next-tool')
  await page.waitForFunction(() => window.__activity.phase === 'text-done', null, { timeout: 60_000 }); await page.waitForTimeout(400)
  await shot('4-reply-streamed')
  // Open the first tool's previews, as a person would.
  await page.locator('[data-coordinator-stream-id] [data-activity-tool="done"] button').first().click()
  await page.waitForTimeout(500); await shot('5-tool-opened')
  await page.locator('[data-coordinator-stream-id] [data-activity-tool="done"] button').first().click()
  // Store the turn as the workflow does, then commit the stream.
  await page.evaluate(() => { document.querySelector('[data-coordinator-stream-id]').__mark = true })
  const position = (await db.query('SELECT coalesce(max(position),0)+1 AS p FROM coordinator_messages WHERE "userId"=$1 AND "botId"=$2', [owner, botId])).rows[0].p
  const streamId = `${run}:0`
  const rows = [
    { role: 'assistant', content: [{ type: 'reasoning', text: readable ? thoughtText : '', ...(readable ? {} : { providerOptions: { anthropic: { redactedData: 'encrypted' } } }) }, { type: 'tool-call', toolCallId: 'c1', toolName: 'create_issue', input: { title: '修复登录跳转', description: '登录后会跳回首页' } }], mikkaStreamId: streamId },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'create_issue', output: { type: 'json', value: { id: issue, identifier: 'MIK-12' } } }], mikkaStreamId: streamId },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c2', toolName: 'dispatch_run', input: { issueId: issue } }], mikkaStreamId: streamId },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c2', toolName: 'dispatch_run', output: { type: 'json', value: { runId: 'r1', status: 'queued', place: 'cloud' } } }], mikkaStreamId: streamId },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c3', toolName: 'list_calendar_events', input: { days: 1 } }], mikkaStreamId: streamId },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c3', toolName: 'list_calendar_events', output: { type: 'error-text', value: 'Google Calendar 未连接' } }], mikkaStreamId: streamId },
    { role: 'assistant', content: [{ type: 'text', text: reply }], mikkaStreamId: streamId },
  ]
  for (const [index, message] of rows.entries()) await db.query('INSERT INTO coordinator_messages (id, "userId", "botId", position, message) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), owner, botId, position + index, message])
  await db.query('UPDATE coordinator_sessions SET "leaseHolder"=NULL, "leaseUntil"=NULL WHERE "userId"=$1 AND "botId"=$2', [owner, botId])
  const commitFrame = castIndex
  await page.evaluate(through => window.__commit(through), position + rows.length - 1)
  const handedOver = await page.waitForFunction(() => !document.querySelector('[data-coordinator-stream-id]') && document.querySelector('[data-activity-thinking="stored"]'), null, { timeout: 60_000 }).then(() => true, () => false)
  await page.waitForTimeout(1200)
  await shot('6-stored')
  const storedThinking = page.locator('[data-activity-thinking="stored"]')
  const storedReadable = await storedThinking.getAttribute('data-reasoning')
  let storedOpenText = null
  if (readable) {
    await storedThinking.locator('button').click()
    await page.waitForFunction(text => document.querySelector('[data-activity-thinking="stored"] [data-slot="collapsible-content"]')?.textContent?.includes(text), thoughtText.slice(0, 10), { timeout: 30_000 })
    await page.waitForTimeout(500); await shot('7-reasoning-open-stored')
    storedOpenText = await storedThinking.locator('[data-slot="collapsible-content"]').textContent()
  } else storedOpenText = await storedThinking.locator('button').isDisabled() ? 'disabled' : 'enabled'
  const sameRow = await page.evaluate(() => document.querySelector('[data-activity-thinking="stored"]')?.closest('[data-message-id]')?.__mark === true)
  const stored = await page.evaluate(() => [...document.querySelectorAll('[data-activity-tool]')].map(row => row.getAttribute('data-activity-tool')))
  await cdp.send('Page.stopScreencast').catch(() => {})
  await Promise.all(castWrites)
  const result = { label, revision: process.env.ACTIVITY_REVISION ?? null, origin: ORIGIN, database: 'mikka_e2e (127.0.0.1, isolated)', run, at: new Date().toISOString(), shots, commitFrame, castFrames: castIndex, handedOver, sameRow, storedToolStates: stored, reasoning: readable ? 'text' : 'none', storedReadable, storedOpenText }
  await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  await db.query('UPDATE coordinator_sessions SET "leaseHolder"=NULL, "leaseUntil"=NULL WHERE "userId"=$1', [owner]).catch(() => {})
  await context.close()
  await browser.close()
  await scope.release({ outcome: 'clean' }).catch(() => {})
  await db.end()
}
