import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, seedTask } from './fixtures'

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Thread card acceptance requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

// This fixture only touches CI's isolated disposable database, never a Preview or production DB.
// It writes the Coordinator turn a dispatch_run leaves behind: the call, its result, then the reply.
async function seedDispatch(email: string, title: string) {
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const { rows: [issue] } = await pool.query<{ id: string }>('SELECT id FROM issues WHERE "userId" = $1 AND title = $2', [user.id, title])
    const agentId = randomUUID()
    const runId = randomUUID()
    await pool.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1, $2, $3, $4)', [agentId, user.id, 'codex', 'Mikka Frontend'])
    await pool.query('INSERT INTO agent_runs (id, "userId", "issueId", "agentId", status, prompt) VALUES ($1, $2, $3, $4, $5, $6)', [runId, user.id, issue.id, agentId, 'running', 'Speed up the home page\nMeasure first.'])
    // What the thread handed over: one document, for the 「Artifact · 1」 entry in its header (F3).
    const artifactId = randomUUID()
    await pool.query('INSERT INTO artifacts (id, "userId", kind, title, "runId", "issueId") VALUES ($1, $2, $3, $4, $5, $6)', [artifactId, user.id, 'markdown', 'Home page timing', runId, issue.id])
    await pool.query('INSERT INTO artifact_versions (id, "artifactId", version, "storageKey", "inlineContent", sha256, size, "authorName") VALUES ($1, $2, 1, $3, $4, $5, $6, $7)', [randomUUID(), artifactId, `e2e/${artifactId}.md`, '# Home page timing\n\n3.8s', 'e2e', 25, 'Mikka Frontend'])
    let seq = 0
    for (const chunk of [{ type: 'text-delta', id: 't1', delta: 'Home page loads in 3.8s.' }, { type: 'tool-input-available', toolCallId: 'a', toolName: 'bash', input: { command: 'pnpm build --profile' } }, { type: 'tool-input-available', toolCallId: 'b', toolName: 'apply_patch', input: { files: ['app/page.tsx'] } }]) {
      await pool.query('INSERT INTO run_chunks (id, "runId", seq, chunk) VALUES ($1, $2, $3, $4)', [randomUUID(), runId, ++seq, JSON.stringify(chunk)])
    }
    const messages = [
      { role: 'user', content: 'The home page is slow' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'dispatch_run', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'dispatch_run', output: { type: 'json', value: { runId, status: 'queued' } } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Mikka Frontend is on it.' }] },
    ]
    for (const [index, message] of messages.entries()) {
      await pool.query('INSERT INTO coordinator_messages (id, "userId", "botId", position, message) VALUES ($1, $2, (SELECT "botId" FROM coordinator_bots WHERE "ownerId" = $2), $3, $4)', [randomUUID(), user.id, index + 1, JSON.stringify(message)])
    }
  } finally { await pool.end() }
}

type ResultCardFixture = { issueId: string; name: string; pullRequests: { url: string; state: 'open' | 'draft' | 'merged' | 'closed' }[] }

// Visual coverage only: these stored output states are not daemon/publication
// acceptance. tests/mvp/core-loop.spec.ts must produce its result through the
// real Coordinator, daemon and publication workflow without seeding any result.
async function seedResultCards(email: string, fixtures: ResultCardFixture[]) {
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const { rows: [agent] } = await pool.query<{ id: string }>('SELECT id FROM agents WHERE "userId" = $1 AND name = $2', [user.id, 'Mikka Frontend'])
    const calls = []
    const results = []
    for (const fixture of fixtures) {
      const runId = randomUUID()
      await pool.query('UPDATE issues SET content = jsonb_set(content, \'{attrs,mikka,pullRequests}\', $2::jsonb) WHERE id = $1 AND "userId" = $3', [fixture.issueId, JSON.stringify(fixture.pullRequests), user.id])
      await pool.query('INSERT INTO agent_runs (id, "userId", "issueId", "agentId", status, prompt, report, "finishedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, now())', [runId, user.id, fixture.issueId, agent.id, 'succeeded', fixture.name, JSON.stringify({ summary: 'Visual result fixture; no daemon was run.' })])
      calls.push({ type: 'tool-call', toolCallId: runId, toolName: 'dispatch_run', input: {} })
      results.push({ type: 'tool-result', toolCallId: runId, toolName: 'dispatch_run', output: { type: 'json', value: { runId, status: 'queued' } } })
    }
    const { rows: [last] } = await pool.query<{ position: number }>('SELECT COALESCE(MAX(position), 0) AS position FROM coordinator_messages WHERE "userId" = $1', [user.id])
    const messages = [
      { role: 'assistant', content: calls },
      { role: 'tool', content: results },
      { role: 'assistant', content: [{ type: 'text', text: 'PR 状态视觉样例。' }] },
    ]
    for (const [index, message] of messages.entries()) {
      await pool.query('INSERT INTO coordinator_messages (id, "userId", "botId", position, message) VALUES ($1, $2, (SELECT "botId" FROM coordinator_bots WHERE "ownerId" = $2), $3, $4)', [randomUUID(), user.id, Number(last.position) + index + 1, JSON.stringify(message)])
    }
  } finally { await pool.end() }
}

test('A dispatched thread is a card under the reply that opens its conversation beside the chat (R-66, R-80)', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.emulateMedia({ colorScheme: 'light' })
  const { email } = await register(page)
  const title = `Thread card ${randomUUID()}`
  await seedTask(page, title)
  await seedDispatch(email, title)
  await page.reload()

  const chat = page.getByRole('region', { name: 'Coordinator', exact: true })
  const card = chat.getByRole('button', { name: '打开线程 Speed up the home page', exact: true })
  await expect(card).toBeVisible()
  const surface = chat.locator('[data-slot="thread-card"]').filter({ has: page.getByRole('button', { name: '打开线程 Speed up the home page', exact: true }) })
  await expect(surface).toContainText('Speed up the home page')
  await expect(surface.getByRole('img', { name: '运行中', exact: true })).toBeVisible()
  // R-66: status icon + title + real output chips; no avatar or progress row.
  await expect(surface).not.toContainText('交给 Codex')
  await expect(surface).not.toContainText('执行了 2 步')
  await testInfo.attach('thread-card', { body: await page.screenshot(), contentType: 'image/png' })

  await card.click()
  const thread = page.getByRole('region', { name: 'Speed up the home page', exact: true })
  await expect(thread.getByRole('list', { name: '线程对话' })).toContainText('Home page loads in 3.8s.')
  await expect(thread.getByRole('textbox', { name: '告诉 Codex 下一步做什么…' })).toBeVisible()
  // The chat stays in the centre and the thread has its own address (R-80).
  await expect(page.getByRole('textbox', { name: '给 Coordinator 发消息' })).toBeVisible()
  await expect(page).toHaveURL(url => /^[0-9a-f-]{36}$/.test(url.searchParams.get('thread') ?? ''))
  await testInfo.attach('thread-open', { body: await page.screenshot(), contentType: 'image/png' })

  // The folded harness steps open to each call and close again, by pointer and by keyboard.
  const steps = thread.getByRole('button', { name: '交给 Codex · 执行了 2 步', exact: true })
  await expect(steps).toHaveAttribute('aria-expanded', 'false')
  await steps.click()
  await expect(steps).toHaveAttribute('aria-expanded', 'true')
  const calls = thread.locator(`[id="${await steps.getAttribute('aria-controls')}"]`)
  await expect(calls).toContainText('pnpm build --profile')
  await expect(calls).toContainText('app/page.tsx')
  await testInfo.attach('thread-steps-open', { body: await page.screenshot(), contentType: 'image/png' })
  await steps.press('Enter')
  await expect(steps).toHaveAttribute('aria-expanded', 'false')
  await steps.press('Space')
  await expect(steps).toHaveAttribute('aria-expanded', 'true')

  // 「Artifact · 1」 opens the Artifact window with this thread's conversation beside it (F3, F4).
  await thread.getByRole('button', { name: 'Artifact · 1', exact: true }).click()
  const artifactWindow = page.getByRole('dialog', { name: 'Home page timing', exact: true })
  await expect(artifactWindow.getByRole('list', { name: '线程对话' })).toContainText('Home page loads in 3.8s.')
  await artifactWindow.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(artifactWindow).toHaveCount(0)

  await thread.getByRole('button', { name: '关闭线程', exact: true }).click()
  await expect(thread).toHaveCount(0)
  await expect(page).toHaveURL(url => !url.searchParams.has('thread'))
  await expect(chat.getByRole('button', { name: '打开线程 Speed up the home page', exact: true })).toBeVisible()

  // Review frame 356:4750. Seed only this visual test's state matrix; the MVP
  // daemon loop has its own separate evidence and never uses this helper.
  const states = ['open', 'draft', 'merged', 'closed'] as const
  const outputs = states.map((state, index) => ({ state, url: `https://github.com/mikka-visual-fixture/cards/pull/${101 + index}` }))
  const fixtures: ResultCardFixture[] = []
  for (const pr of outputs) {
    const name = `PR ${pr.state} fixture`
    fixtures.push({ name, issueId: await seedTask(page, `${name} ${randomUUID()}`), pullRequests: [pr] })
  }
  fixtures.push({ name: 'More PR outputs fixture', issueId: await seedTask(page, `PR overflow ${randomUUID()}`), pullRequests: outputs })
  await seedResultCards(email, fixtures)
  await page.reload()
  const resultCard = (name: string) => chat.locator('[data-slot="thread-card"]').filter({ has: page.getByRole('button', { name: `打开线程 ${name}`, exact: true }) })

  // The anchor must open its target, without bubbling into the card's thread.
  await page.context().route('https://github.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>PR visual fixture destination</title>' }))
  const popupOpened = page.waitForEvent('popup')
  await resultCard(fixtures[0].name).getByRole('link', { name: 'PR #101', exact: true }).click()
  const popup = await popupOpened
  try { await expect(popup).toHaveURL(outputs[0].url) } finally { await popup.close() }
  await expect(chat).toBeVisible()
  await expect(chat.locator('[data-slot="thread-card"]')).toHaveCount(6)
  await expect(page.getByRole('region', { name: fixtures[0].name, exact: true })).toHaveCount(0)

  const measurements = []
  for (const view of [
    { name: 'light', colorScheme: 'light', width: 1440, height: 960 },
    { name: 'dark', colorScheme: 'dark', width: 1440, height: 960 },
    { name: 'narrow-light', colorScheme: 'light', width: 390, height: 844 },
    { name: 'narrow-dark', colorScheme: 'dark', width: 390, height: 844 },
  ] as const) {
    await page.setViewportSize({ width: view.width, height: view.height })
    await page.emulateMedia({ colorScheme: view.colorScheme })
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${view.colorScheme}\\b`))
    for (const [index, fixture] of fixtures.entries()) {
      const outputCard = resultCard(fixture.name)
      await expect(outputCard).toBeVisible()
      await expect(outputCard).not.toContainText('执行了')
      await expect(outputCard).not.toContainText('交给 Codex')
      await expect(outputCard).not.toContainText('Visual result fixture')
      if (index < states.length) {
        const pr = fixture.pullRequests[0]
        const link = outputCard.getByRole('link', { name: `PR #${101 + index}`, exact: true })
        await expect(link).toHaveAttribute('data-pr-state', pr.state)
        await expect(link).toHaveAttribute('href', pr.url)
      } else {
        const visible = await outputCard.getByRole('link').count()
        expect(visible).toBeLessThanOrEqual(2)
        await expect(outputCard.getByText(`+${outputs.length - visible}`, { exact: true }).filter({ visible: true })).toBeVisible()
      }
      await outputCard.scrollIntoViewIfNeeded()
      const bounds = await outputCard.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.width).toBeLessThanOrEqual(view.width)
      measurements.push({ view: view.name, fixture: fixture.name, viewport: { width: view.width, height: view.height }, bounds })
      await testInfo.attach(`r66-${index < states.length ? states[index] : 'overflow'}-${view.name}`, { body: await outputCard.screenshot(), contentType: 'image/png' })
    }
    await testInfo.attach(`r66-context-${view.name}`, { body: await page.screenshot(), contentType: 'image/png' })
  }
  await testInfo.attach('r66-visual-fixture-bounds.json', { body: JSON.stringify({ frame: '356:4750', boundary: 'Seeded UI state fixtures only; not real daemon or GitHub publication acceptance. Card screenshots are direct component captures, without post-processing. Actual bounds are recorded; no equal-width pixel comparison is claimed.', measurements }, null, 2), contentType: 'application/json' })
})
