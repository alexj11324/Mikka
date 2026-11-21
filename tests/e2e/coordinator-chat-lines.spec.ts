import { randomBytes, randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { Pool } from 'pg'
import { test as base, expect, app, browserClientHeaders, captureAuthenticationCookies, seedCoordinatorError, skipOnboarding } from './fixtures'
import { attachLightDark } from './settings-v4-shots'
import { recordAuthenticationSecrets } from '../../scripts/test-accounts/session.mjs'

// Second usability review C1, C4, C5: the chat never shows what the model was told (English, ids,
// instructions) or a raw step error, and a past failure keeps one way on.

// These cases start with an authenticated person, as group-chat-send does. The
// real same-origin signup supplies the cookies before the browser opens the app;
// registration UI coverage stays in its own cases and runtimeGuard stays active.
const test = base.extend<{ register: (page: Page) => Promise<{ email: string }> }>({
  register: async ({ playwright, baseURL }, use) => {
    const client = await playwright.request.newContext({ baseURL, extraHTTPHeaders: browserClientHeaders() })
    const origin = new URL(baseURL!).origin
    try {
      await use(async page => {
        const email = `e2e-${randomUUID()}@example.com`
        const password = randomBytes(32).toString('base64url')
        if (process.env.MIKKA_TEST_ENVIRONMENT_FILE) await recordAuthenticationSecrets([password])
        try {
          const signed = await client.post(app('/api/auth/sign-up/email'), {
            headers: { origin }, data: { email, password, name: '回归测试成员' },
          })
          expect(signed.ok()).toBeTruthy()
          await page.context().addCookies((await client.storageState()).cookies)
          await page.goto(app('/'))
          await skipOnboarding(page, email)
          return { email }
        } finally { await captureAuthenticationCookies(page.context()) }
      })
    } finally { await client.dispose() }
  },
})

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('This spec requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

test('runtime events read as lines in the person\'s language, with the thread as a chip (C1)', async ({ page, register }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { email } = await register(page)
  await expect(page.getByRole('textbox', { name: '给 Coordinator 发消息', exact: true })).toBeVisible()
  const runId = randomUUID()
  const issueId = randomUUID()
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const { rows: [coordinator] } = await pool.query<{ botId: string; workspaceId: string }>(`SELECT c."botId", c."workspaceId"
      FROM coordinator_bots c JOIN mikka_workspaces w ON w.id = c."workspaceId"
      WHERE c."ownerId" = $1 AND w."userId" = $1 AND w.kind = 'personal' LIMIT 1`, [user.id])
    if (!coordinator) throw new Error('The new account has no personal Coordinator')
    const agentId = randomUUID()
    await pool.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1, $2, $3, $4)', [agentId, user.id, 'codex', 'Coordinator'])
    // The recorded task range is the only thing allowed to name a thread (lib/run-bot-name.ts); without it the
    // citation falls back to the agent name and the waiting sentence could not name the task it links.
    await pool.query('INSERT INTO agent_runs (id, "userId", "workspaceId", "agentId", status, prompt, "promptTaskStart", "promptTaskLength") VALUES ($1, $2, $3, $4, $5, $6, 0, char_length($6))',
      [runId, user.id, coordinator.workspaceId, agentId, 'waiting_input', '改用 msw 还是只改这两个测试'])
    // What the server stores for each event (eventPrompt + sourcedEventMessage): the model's text and its kind.
    const events = [
      { kind: 'run_question', text: `[Event] The agent in run ${runId} asks the person: msw or just these two tests?\nCheck the current run state and existing task facts first. Never invent their permission. send_to_run does not itself prove the run resumed.` },
      { kind: 'issue_status_changed', text: `[Event] Issue ${issueId} "登录页在 Safari 17 上白屏" moved from todo to review.` },
      { kind: 'run_retried', text: `[Event] Run ${runId} lost its machine (the device went offline or its cloud sandbox is gone), so it was moved to a new cloud sandbox as run ${randomUUID()}, attempt 2 of 3.\nNothing to do; follow the new run.` },
    ]
    for (const event of events) {
      await pool.query(`INSERT INTO coordinator_messages (id, "userId", "botId", position, message)
        SELECT $1, $2, $3, coalesce(max(position), 0) + 1, $4 FROM coordinator_messages WHERE "userId" = $2 AND "botId" = $3`,
      [randomUUID(), user.id, coordinator.botId, JSON.stringify({ role: 'user', content: event.text, mikkaEvent: { packet: '', eventKind: event.kind, observedState: null } })])
    }
  } finally { await pool.end() }
  await page.reload()
  const chat = page.getByRole('region', { name: 'Coordinator 线程', exact: true })
  // A question is a live state above the composer, not a stored event row (decision 2026-11-10); the thread stays an
  // inline link inside one sentence. The sentence lives in the composer column, outside the transcript region the
  // `chat` locator names, so it is read from the surface that holds both.
  const waiting = page.locator('[data-slot="waiting-questions"]')
  await expect(waiting).toContainText('在等你回答')
  // Decision 2026-11-13-1405: every thread reference uses the bounded short title.
  await expect(waiting).toContainText('改用 msw 还是只改这')
  await expect(chat.locator('[data-event-line="runQuestion"]')).toHaveCount(0)
  await expect(chat.locator('[data-event-line="issueStatus"]')).toHaveText('「登录页在 Safari 17 上白屏」改为评审中')
  await expect(chat.locator('[data-event-line="runRetried"]')).toContainText('换了一台机器继续')
  for (const leak of ['[Event]', 'asks the person', 'send_to_run', runId, issueId]) await expect(chat.getByText(leak, { exact: false })).toHaveCount(0)
  await attachLightDark(page, testInfo, 'chat-event-lines')
})

test('a failed reply says 回复失败 with 重试, never the step error; later it keeps 重新发送 (C4, C5)', async ({ page, register }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await register(page)
  await expect(page.getByRole('textbox', { name: '给 Coordinator 发消息', exact: true })).toBeVisible()
  const raw = 'Step "step//./workflows/coordinator/agent-kit-steps//botRuntime" failed after 3 retries: fetch failed (ECONNRESET)'
  await seedCoordinatorError(page, raw, undefined, '帮我看看 CI 为什么红了')
  await page.reload()
  const live = page.locator('[data-message-failure="live"]')
  await expect(live).toContainText('回复失败')
  await expect(live.getByRole('button', { name: '重试', exact: true })).toBeVisible()
  await expect(page.getByText('ECONNRESET', { exact: false })).toHaveCount(0)
  await expect(page.getByText('botRuntime', { exact: false })).toHaveCount(0)
  await attachLightDark(page, testInfo, 'chat-failed-live')
  // A later turn ended cleanly: the reason stays under the message with its way on.
  await seedCoordinatorError(page, '')
  await page.reload()
  const past = page.locator('[data-message-failure="past"]')
  await expect(past).toContainText('回复失败')
  await expect(past.getByRole('button', { name: '重新发送', exact: true })).toBeVisible()
  await attachLightDark(page, testInfo, 'chat-failed-past')
  // 重新发送 retries in place (Alex, 2026-11-02): one message stays, the attempt that failed and its line go,
  // now and after a reload; a failure of the new attempt shows only under it.
  await past.getByRole('button', { name: '重新发送', exact: true }).click()
  const chat = page.getByRole('region', { name: 'Coordinator 线程', exact: true })
  await expect(chat.getByText('帮我看看 CI 为什么红了', { exact: true })).toHaveCount(1)
  await expect(chat.locator('[data-message-failure]')).toHaveCount(0)
  await attachLightDark(page, testInfo, 'chat-failed-resent')
  await page.reload()
  await expect(chat.getByText('帮我看看 CI 为什么红了', { exact: true })).toHaveCount(1)
})

test('a cold start shows the shapes of the chat and the thread list, never 还没有线程 (C7)', async ({ page, register }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await register(page)
  await expect(page.getByRole('textbox', { name: '给 Coordinator 发消息', exact: true })).toBeVisible()
  // Hold the current Web RPC reads for the chat and threads as a slow network
  // would on a cold start; bootstrap must finish before either surface mounts.
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const heldReads = new Set(['coordinator.syncCoordinatorChat', 'task-runs.syncThreadList'])
  await page.route('**/*', async route => {
    const request = route.request()
    if (request.method() === 'POST' && new URL(request.url()).pathname === app('/api/rpc')
      && heldReads.has(request.postDataJSON()?.action)) await held
    await route.fallback()
  })
  try {
    // Registration has already opened the app and populated its persistent read
    // cache. Unload the app's IndexedDB connections before clearing that cache
    // so these held reads start without a stored chat or thread-list value.
    const applicationUrl = page.url()
    await page.goto(app('/api/version'))
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const deletion = indexedDB.deleteDatabase('mikka-read-cache')
      deletion.onsuccess = () => resolve()
      deletion.onerror = () => reject(deletion.error ?? new Error('Could not clear the read cache before a cold start'))
      deletion.onblocked = () => reject(new Error('The read cache is still open before a cold start'))
    }))
    await page.goto(applicationUrl)
    const chat = page.getByRole('region', { name: 'Coordinator 线程', exact: true })
    await expect(chat.getByRole('status', { name: '加载中…', exact: true })).toBeVisible()
    await expect(page.getByText('还没有线程', { exact: true })).toHaveCount(0)
    await attachLightDark(page, testInfo, 'chat-cold-start')
  } finally { release() }
  await page.unroute('**/*')
})
