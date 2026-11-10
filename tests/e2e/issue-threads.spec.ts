import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, watchRuntime, seedTask, seedTeamWorkspace, openIssueFromSearch, openSearch } from './fixtures'

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Issue thread acceptance requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

// This fixture only touches CI's isolated disposable database, never a Preview or production DB.
async function seedThreads(email: string, title: string, workspaceId: string | null = null) {
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const { rows: [issue] } = await pool.query<{ id: string }>('SELECT id FROM issues WHERE "userId" = $1 AND title = $2', [user.id, title])
    const agentId = randomUUID()
    await pool.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1, $2, $3, $4)', [agentId, user.id, 'codex', 'Coordinator'])
    for (const [status, prompt, summary] of [['succeeded', 'Model the routing table', 'PR #95 merged'], ['running', 'Route group replies', null]] as const) {
      const runId = randomUUID()
      await pool.query('INSERT INTO agent_runs (id, "userId", "issueId", "agentId", status, prompt, report, "workspaceId") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [runId, user.id, issue.id, agentId, status, prompt, summary && JSON.stringify({ summary }), workspaceId])
      await pool.query('INSERT INTO run_chunks (id, "runId", seq, chunk) VALUES ($1, $2, 1, $3)', [randomUUID(), runId, JSON.stringify({ type: 'text-delta', id: runId, delta: `线程回复 for ${prompt}` })])
    }
    return issue.id
  } finally { await pool.end() }
}

test('Issue threads open on the right as a conversation; comments are cards with replies inside', async ({ page, browser }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const { email } = await register(page)
  const title = `Thread detail ${randomUUID()}`
  await seedTask(page, title)
  const issueId = await seedThreads(email, title)
  await openIssueFromSearch(page, title)
  await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(title)
  const threads = page.getByRole('region', { name: /^线程/ })
  await expect(threads.getByRole('button', { name: /^打开线程 / })).toHaveCount(2)
  await expect(threads.getByText('PR #95 merged', { exact: true })).toBeVisible()
  // Activity records each dispatch as a plain row.
  const activity = page.getByRole('region', { name: '任务活动', exact: true })
  await expect(activity.getByText('派出线程')).toHaveCount(2)

  // This finished fixture lacks a repository and session, so it must not probe feedback eligibility.
  const feedbackRequests: string[] = []
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/api/self-improvement')) feedbackRequests.push(request.url()) })
  await page.route('**/api/self-improvement?runId=*', route => route.fulfill({ status: 500, body: 'Unexpected feedback probe' }))
  // A finished thread reads as a conversation and still ends in the composer: a message runs it again (R-10, R-81, #892). Nothing to stop.
  await threads.getByRole('button', { name: '打开线程 Model the routing table', exact: true }).click()
  let panel = page.getByRole('region', { name: 'Model the routing table', exact: true })
  await expect(panel.getByRole('list', { name: '线程对话' })).toContainText('线程回复 for Model the routing table')
  await expect(panel.getByRole('textbox', { name: '告诉 Codex 下一步做什么…' })).toBeVisible()
  await expect(panel.getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
  expect(feedbackRequests).toEqual([])

  // A running thread ends in the composer; what is said there goes to the agent and stays in the thread.
  await threads.getByRole('button', { name: '打开线程 Route group replies', exact: true }).click()
  panel = page.getByRole('region', { name: 'Route group replies', exact: true })
  await panel.getByRole('textbox', { name: '告诉 Codex 下一步做什么…' }).fill('Check the fallback timer')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect(panel.getByRole('list', { name: '线程对话' })).toContainText('Check the fallback timer')
  expect(feedbackRequests).toEqual([])
  await testInfo.attach('thread-open', { body: await page.screenshot(), contentType: 'image/png' })
  await panel.getByRole('button', { name: '返回', exact: true }).click()
  await expect(panel).toHaveCount(0)

  // Comments are cards; a reply is written inside the card.
  await activity.getByLabel('评论内容').fill('Ship it after e2e')
  await activity.getByRole('button', { name: '发送评论', exact: true }).click()
  const card = activity.getByRole('article', { name: /的评论$/ })
  await expect(card).toContainText('Ship it after e2e')
  await card.getByLabel('回复内容').fill('Agreed')
  await card.getByRole('button', { name: '发送回复', exact: true }).click()
  await expect(card).toContainText('Agreed')
  // The first crumb names the chat the task was opened from; leaving through it uses the existing document flush before unmounting the editor.
  await page.getByRole('navigation', { name: '当前位置', exact: true }).getByRole('button', { name: 'Coordinator', exact: true }).click()
  await openIssueFromSearch(page, title)
  await page.reload()
  await expect(page.getByRole('region', { name: '任务活动', exact: true }).getByRole('article', { name: /的评论$/ })).toContainText('Agreed')

  // A personal issue is the owner's alone (R-26): a legacy invitation doesn't reveal it or its threads.
  const colleague = await browser.newContext({ locale: 'zh-CN' })
  const colleagueErrors = watchRuntime(colleague)
  try {
    const teammatePage = await colleague.newPage()
    await teammatePage.setViewportSize({ width: 1440, height: 960 })
    const teammate = await register(teammatePage)
    const pool = isolatedPool()
    try {
      const { rows: [owner] } = await pool.query('SELECT id FROM "user" WHERE email=$1', [email])
      const { rows: [member] } = await pool.query('SELECT id FROM "user" WHERE email=$1', [teammate.email])
      await pool.query('INSERT INTO issue_members ("issueId","userId","memberId") VALUES ($1,$2,$3)', [issueId, owner.id, member.id])
    } finally { await pool.end() }
    await teammatePage.reload()
    const search = await openSearch(teammatePage)
    await search.getByRole('combobox', { name: '全局搜索', exact: true }).fill(title)
    await expect(search.getByRole('listbox').getByText('没有匹配的结果', { exact: true })).toBeVisible()
    await expect(search.getByRole('status')).toHaveText('没有匹配的结果')
    await expect(search.getByRole('option').filter({ hasText: title })).toHaveCount(0)
    await expect(teammatePage.getByText('Route group replies')).toHaveCount(0)
    await expect(teammatePage.getByText('线程回复', { exact: false })).toHaveCount(0)
  } finally {
    await colleague.close()
    expect(colleagueErrors).toEqual([])
  }
})

for (const view of [{ name: 'desktop', width: 1440, height: 960 }, { name: 'narrow', width: 390, height: 844 }] as const) {
// Start at the reviewed size: changing the task's desktop/mobile layout mid-run
// remounts its thread panel and would test a different draft-lifetime behavior.
test(`The owner stops a working thread from its composer; one waiting for an answer sends; it reads 正在停止… until the run ends (${view.name})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: view.width, height: view.height })
  await page.emulateMedia({ colorScheme: 'light' })
  const { email } = await register(page)
  const title = `Thread stop ${randomUUID()}`
  await seedTask(page, title)
  const pool = isolatedPool()
  const runs: Record<string, string> = {}
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const { rows: [issue] } = await pool.query<{ id: string }>('SELECT id FROM issues WHERE "userId" = $1 AND title = $2', [user.id, title])
    const agentId = randomUUID()
    await pool.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1, $2, $3, $4)', [agentId, user.id, 'codex', 'Coordinator'])
    for (const [status, prompt] of [['waiting_input', 'Pick a cache key'], ['running', 'Trim the bundle']] as const) {
      runs[status] = randomUUID()
      await pool.query('INSERT INTO agent_runs (id, "userId", "issueId", "agentId", status, prompt) VALUES ($1, $2, $3, $4, $5, $6)', [runs[status], user.id, issue.id, agentId, status, prompt])
    }
  } finally { await pool.end() }
  await openIssueFromSearch(page, title)
  const threads = page.getByRole('region', { name: /^线程/ })

  // Waiting for your answer is live but idle (usability review N1): the composer sends, never stops, even when empty;
  // stop stays in the header.
  await threads.getByRole('button', { name: '打开线程 Pick a cache key', exact: true }).click()
  let panel = page.getByRole('region', { name: 'Pick a cache key', exact: true })
  const waitingComposer = panel.locator('[data-slot="thread-composer"]')
  await expect(waitingComposer.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
  await expect(waitingComposer.getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
  await expect(panel.locator('[data-slot="thread-stop"]')).toBeVisible()
  await testInfo.attach(`thread-waiting-send-${view.name}-light`, { body: await page.screenshot(), contentType: 'image/png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await testInfo.attach(`thread-waiting-send-${view.name}-dark`, { body: await page.screenshot(), contentType: 'image/png' })
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await waitingComposer.getByRole('textbox').fill('Use the user id')
  await expect(waitingComposer.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
  await waitingComposer.getByRole('textbox').fill('')
  await expect(waitingComposer.getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
  await panel.getByRole('button', { name: '返回', exact: true }).click()

  await threads.getByRole('button', { name: '打开线程 Trim the bundle', exact: true }).click()
  panel = page.getByRole('region', { name: 'Trim the bundle', exact: true })
  const composer = panel.getByRole('textbox', { name: '告诉 Codex 下一步做什么…' })
  const stop = panel.locator('[data-slot="thread-composer"]').getByRole('button', { name: '停止', exact: true })
  // A working thread: the header keeps stop as well.
  await expect(panel.locator('[data-slot="thread-stop"]')).toBeVisible()
  // Typing turns stop into send; clearing the draft brings stop back.
  await composer.fill('Keep the polyfills')
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
  await expect(stop).toHaveCount(0)
  await composer.fill('')
  await expect(stop).toBeVisible()
  await testInfo.attach(`thread-stop-running-${view.name}-light`, { body: await page.screenshot(), contentType: 'image/png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await testInfo.attach(`thread-stop-running-${view.name}-dark`, { body: await page.screenshot(), contentType: 'image/png' })
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).not.toHaveClass(/dark/)

  await page.clock.install()
  await stop.click()
  await expect(panel.getByText('正在停止…', { exact: true })).toBeVisible()
  await expect(threads.getByRole('button', { name: '打开线程 Trim the bundle', exact: true })).toContainText('正在停止…')
  await expect(stop).toHaveCount(0)
  await expect(panel.locator('[data-slot="thread-stop"]')).toHaveCount(0)
  await expect(composer).toBeEditable()
  await composer.fill('Keep this draft while stopping')
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
  const check = isolatedPool()
  try {
    await expect.poll(async () => (await check.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id = $1', [runs.running])).rows[0].stopRequestedAt).not.toBeNull()
    const originalStop = (await check.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id = $1', [runs.running])).rows[0].stopRequestedAt
    await testInfo.attach(`thread-stop-stopping-${view.name}-light`, { body: await page.screenshot(), contentType: 'image/png' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveClass(/dark/)
    await testInfo.attach(`thread-stop-stopping-${view.name}-dark`, { body: await page.screenshot(), contentType: 'image/png' })
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    // An offline daemon never acknowledges. The timeout unlocks retry, not the draft.
    await page.clock.fastForward(30_100)
    await expect(panel.getByRole('alert')).toContainText('停止未确认')
    await expect(composer).toHaveValue('Keep this draft while stopping')
    await expect(composer).toBeEditable()
    await testInfo.attach(`thread-stop-timeout-${view.name}-light`, { body: await page.screenshot(), contentType: 'image/png' })
    // Review frame 372:4786: the same actual timeout, editable draft and retry
    // control in both themes, not a seeded replacement for the stopped state.
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect(panel.getByRole('alert')).toContainText('停止未确认')
    await expect(composer).toHaveValue('Keep this draft while stopping')
    await expect(composer).toBeEditable()
    await expect(panel.getByRole('button', { name: '重试停止', exact: true })).toBeEnabled()
    await testInfo.attach(`thread-stop-timeout-${view.name}-dark`, { body: await page.screenshot(), contentType: 'image/png' })
    await testInfo.attach(`thread-stop-${view.name}-bounds.json`, { body: JSON.stringify({ frame: '372:4786', viewport: { width: view.width, height: view.height }, bounds: await panel.boundingBox(), boundary: 'UI fixture with no daemon acknowledgement; the real stop action and 30-second timeout execute. Terminal acknowledgement below is seeded separately.' }, null, 2), contentType: 'application/json' })
    const retryRequest = page.waitForRequest(request => request.method() === 'POST' && !!request.headers()['next-action'] && request.postData()?.includes(runs.running) === true)
    await panel.getByRole('button', { name: '重试停止', exact: true }).click()
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await expect(composer).toHaveValue('Keep this draft while stopping')
    await expect(panel.getByText('正在停止…', { exact: true })).toBeVisible()
    // The stopping UI is optimistic: finish this retry before seeding daemon acknowledgement.
    const retryResponse = await (await retryRequest).response()
    expect(retryResponse).not.toBeNull()
    expect(retryResponse?.status()).toBe(200)
    expect((await check.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id = $1', [runs.running])).rows[0].stopRequestedAt).toEqual(originalStop)
    // The daemon ends the run.
    await check.query('UPDATE agent_runs SET status = $2, "finishedAt" = now() WHERE id = $1', [runs.running, 'stopped'])
    await page.clock.fastForward(2_100)
  } finally { await check.end() }
  // The badge says the thread's group, as its icon does (R-52, #929): a stopped run nobody judged is 等待你, never 已解决.
  // It keeps the composer, and the stop button goes (R-10, #892).
  await expect(panel.getByText('等待你', { exact: true })).toBeVisible()
  await expect(panel.getByText('正在停止…', { exact: true })).toHaveCount(0)
  await expect(threads.getByRole('button', { name: '打开线程 Trim the bundle', exact: true })).toContainText('等待你')
  await expect(composer).toBeEditable()
  await expect(stop).toHaveCount(0)
})
}

// Usability review N2: a failed thread's error line has 重试 beside it, which runs the thread again (R-81).
test('A failed thread offers 重试 beside its error', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const { email } = await register(page)
  const title = `Thread failed ${randomUUID()}`
  await seedTask(page, title)
  const pool = isolatedPool()
  const runId = randomUUID()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const { rows: [issue] } = await pool.query<{ id: string }>('SELECT id FROM issues WHERE "userId" = $1 AND title = $2', [user.id, title])
    const agentId = randomUUID()
    await pool.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1, $2, $3, $4)', [agentId, user.id, 'codex', 'Coordinator'])
    await pool.query('INSERT INTO agent_runs (id, "userId", "issueId", "agentId", status, prompt, error, "finishedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, now())',
      [runId, user.id, issue.id, agentId, 'failed', 'Reproduce the Safari crash', "browserType.launch: Executable doesn't exist"])
  } finally { await pool.end() }
  await openIssueFromSearch(page, title)
  await page.getByRole('region', { name: /^线程/ }).getByRole('button', { name: '打开线程 Reproduce the Safari crash', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Reproduce the Safari crash', exact: true })
  const failure = panel.locator('[data-slot="thread-failure"]')
  await expect(failure).toContainText("browserType.launch: Executable doesn't exist")
  const retry = failure.getByRole('button', { name: '重试', exact: true })
  await expect(retry).toBeEnabled()
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await testInfo.attach(`thread-failed-retry-${scheme}`, { body: await page.screenshot(), contentType: 'image/png' })
  }
  await page.emulateMedia({ colorScheme: 'light' })
  // 重试 is a message to the thread, as typing one would be.
  const request = page.waitForRequest(request => request.method() === 'POST' && !!request.headers()['next-action'] && request.postData()?.includes(runId) === true && request.postData()?.includes('重试') === true)
  await retry.click()
  await request
})

// #1891 review: the header's narrow layout follows its own column, never the
// viewport. A 1440 px window still opens a 320–360 px right column, so a
// `max-sm:` header never wrapped there. Measured, not asserted from class names:
// the column is forced to the two widths the review named.
test('the thread header wraps by its column width at 320 and stays one row at 360', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const { email } = await register(page)
  const title = `Thread header width ${randomUUID()}`
  await seedTask(page, title)
  // The mode read needs the run's workspace and the reader's membership in it
  // (app/api/threads/[runId]/mode); without them the header has no third item.
  const workspaceId = await seedTeamWorkspace(page)
  await seedThreads(email, title, workspaceId)
  await openIssueFromSearch(page, title)
  await page.getByRole('region', { name: /^线程/ }).getByRole('button', { name: '打开线程 Model the routing table', exact: true }).click()
  const container = page.locator('[data-slot="thread-header-container"]')
  await expect(container).toBeVisible()
  await expect(page.locator('[data-slot="thread-mode-slot"]')).toBeVisible()
  const header = container.locator('header')
  const height = async () => Math.round((await header.boundingBox())?.height ?? 0)
  const setColumn = (width: number) => container.evaluate((node, value) => {
    // The container's own inline size is what the query reads.
    node.style.width = `${value}px`
    node.style.maxWidth = `${value}px`
  }, width)
  await setColumn(320)
  // Narrower than 22rem: the mode control drops to a second row.
  await expect.poll(height).toBeGreaterThan(60)
  await setColumn(360)
  // Wider than 22rem: the same header is one 48 px row again.
  await expect.poll(height).toBe(48)
  // The viewport never moved.
  expect(await page.viewportSize()).toEqual({ width: 1440, height: 960 })
})
