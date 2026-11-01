import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, seedTask, rail, app } from './fixtures'

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Board card acceptance requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

/**
 * Two tasks the way a Bot leaves them: one owned by a Bot (rose blob) whose threads ran on
 * Claude Code, Codex and Cursor, assigned to the person, with a merged PR and a due date;
 * one with an open PR and nobody on it.
 */
async function seedCardTasks(email: string, botTask: string, prTask: string) {
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string; name: string; workspaceId: string }>('SELECT u.id, u.name, m."workspaceId" FROM "user" u JOIN mikka_workspace_members m ON m."userId" = u.id WHERE u.email = $1 LIMIT 1', [email])
    const metadata = (title: string, extra: object) => pool.query(`UPDATE issues SET content = jsonb_set(content, '{attrs,mikka}', (content->'attrs'->'mikka') || $3::jsonb) WHERE "userId" = $1 AND title = $2 RETURNING id`, [user.id, title, JSON.stringify(extra)])
    const { rows: [issue] } = await metadata(botTask, { assignee: { kind: 'member', id: user.id, name: user.name, image: null }, dueDate: '2026-10-30', pullRequests: [{ url: 'https://github.com/mikka-e2e/board/pull/95', state: 'merged' }] })
    await metadata(prTask, { pullRequests: [{ url: 'https://github.com/mikka-e2e/board/pull/96', state: 'open' }] })
    const botId = randomUUID()
    await pool.query('INSERT INTO bots (id, "ownerId", "workspaceId", name, color, shape) VALUES ($1, $2, $3, $4, $5, $6)', [botId, user.id, user.workspaceId, '看板助手', 'rose', 'nuage'])
    const minutes = (value: number) => new Date(Date.now() - value * 60_000)
    for (const [harness, status, age] of [['cursor', 'succeeded', 30], ['codex', 'succeeded', 20], ['claude_code', 'waiting_input', 10]] as const) {
      const agentId = randomUUID()
      await pool.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1, $2, $3, $4)', [agentId, user.id, harness, `Board ${harness}`])
      await pool.query('INSERT INTO agent_runs (id, "userId", "issueId", "agentId", "botId", status, prompt, "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [randomUUID(), user.id, issue.id, agentId, botId, status, 'Board card fixture', minutes(age)])
    }
    return user.id
  } finally {
    await pool.end()
  }
}

for (const width of [1280, 1440]) {
  test(`${width}px，Coordinator 侧栏打开：列宽固定 300，只有已完成折成窄条，放不下就横向滚动`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await register(page)
    await seedTask(page, '窄条里的已完成任务', { status: 'done' })
    await seedTask(page, '待整理里的任务', { status: 'backlog' })
    await page.goto(app('/'))
    await rail(page, '看板').click()

    const board = page.getByRole('region', { name: '横向滚动任务看板', exact: true })
    const strip = page.getByRole('button', { name: '展开已完成列', exact: true })
    await expect(strip).toBeVisible()
    expect((await strip.boundingBox())!.width).toBe(40)
    await expect(page.getByRole('button', { name: '展开待整理列', exact: true })).toHaveCount(0)
    await expect(page.getByText('窄条里的已完成任务', { exact: true })).toHaveCount(0)

    // The strip's name reads top to bottom: no two glyphs share a line.
    const glyphs = await strip.locator('span[aria-hidden="true"] > span').evaluateAll(spans => spans.map(span => span.getBoundingClientRect()).map(box => ({ top: box.top, height: box.height })))
    expect(glyphs.map((_, index) => index)).toEqual([0, 1, 2])
    for (let index = 1; index < glyphs.length; index += 1) expect(glyphs[index].top).toBeGreaterThanOrEqual(glyphs[index - 1].top + glyphs[index - 1].height - 1)

    // Every expanded column is 300px (R-25); the board scrolls instead of squeezing them.
    const columns = await board.locator('[data-slot="kanban-column"]').evaluateAll(items => items.map(item => Math.round(item.getBoundingClientRect().width)))
    expect(columns.filter(value => value !== 40)).toEqual([300, 300, 300, 300])
    const metrics = await board.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }))
    expect(metrics.scroll).toBeGreaterThan(metrics.client)

    // Keyboard scrolling on the board region (ArrowRight, End, Home).
    await board.focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => board.evaluate(el => el.scrollLeft)).toBeGreaterThan(0)
    await page.keyboard.press('End')
    await expect.poll(() => board.evaluate(el => el.scrollLeft + el.clientWidth)).toBeGreaterThanOrEqual(metrics.scroll - 1)
    await page.keyboard.press('Home')
    await expect.poll(() => board.evaluate(el => el.scrollLeft)).toBe(0)

    await strip.click()
    await expect(page.getByText('窄条里的已完成任务', { exact: true })).toBeVisible()
  })
}

test('1024px：Coordinator 侧栏默认收起，展开时浮在看板上；无编号不占位，列表没有版本号', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await register(page)
  await seedTask(page, '窄窗口里的任务', { status: 'todo' })
  await page.goto(app('/'))
  await rail(page, '看板').click()

  // Below 1280 the 360px panel would squeeze the board (R-65): it starts folded, and no column folds to a strip.
  const card = page.getByRole('group', { name: '窄窗口里的任务', exact: true })
  await expect(card).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Coordinator', exact: true })).toBeHidden()
  await expect(page.getByRole('button', { name: '展开已完成列', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '展开对话', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Coordinator', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  // Linear sync is off, so the task has no number: no placeholder on the card (R-25, R-40).
  await expect(card.getByText('正在分配编号', { exact: true })).toHaveCount(0)

  // The list: no number placeholder, no internal version, priority as the card's icon.
  await page.getByRole('button', { name: '列表视图', exact: true }).click()
  const list = page.getByLabel('任务列表', { exact: true })
  const row = list.getByRole('button', { name: /窄窗口里的任务/ })
  await expect(row).toBeVisible()
  await expect(row.getByText('正在分配编号', { exact: true })).toHaveCount(0)
  await expect(row.getByText(/^v\d+$/)).toHaveCount(0)
  await expect(row.getByRole('img', { name: '中', exact: true })).toBeVisible()
})

test('看板工具栏：范围切换、筛选和筛选条同高', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await register(page)
  await page.goto(app('/'))
  await rail(page, '看板').click()

  const toolbar = page.getByRole('toolbar', { name: '看板工具栏', exact: true })
  const scope = toolbar.getByRole('group', { name: '任务范围', exact: true })
  const filter = toolbar.getByRole('button', { name: '筛选', exact: true })
  // The default filter is 负责人: 我, shown as one chip.
  const chip = toolbar.getByRole('group', { name: '负责人', exact: true })
  await expect(chip).toContainText('我')
  await expect(chip.getByRole('button', { name: '移除负责人筛选', exact: true })).toBeVisible()

  const heights = await Promise.all([scope, filter, chip].map(async item => (await item.boundingBox())!.height))
  expect(heights).toEqual([28, 28, 28])
})

// A due date is a calendar day: it reads the same on either side of UTC (seeded 10-30, never 「10月29日」).
for (const timezoneId of ['America/Los_Angeles', 'Asia/Shanghai']) test.describe(timezoneId, () => {
  test.use({ timezoneId })

  test(`看板卡片：Bot 头像组、PR 状态色、个人任务提示、截止日期不早一天（${timezoneId}）`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const email = `e2e-${randomUUID()}@example.com`
    await register(page, '/', email)
    await seedTask(page, 'Bot 负责的看板任务', { status: 'doing' })
    await seedTask(page, '只有 PR 的看板任务', { status: 'todo' })
    const viewerId = await seedCardTasks(email, 'Bot 负责的看板任务', '只有 PR 的看板任务')
    // GitHub's answer for this viewer, as in github-integration: #95 merged, #96 open.
    await page.route('**/api/github/pull-request-status', route => {
      const { url } = route.request().postDataJSON() as { url: string }
      return route.fulfill({ json: { viewerId, state: url.endsWith('/95') ? 'merged' : 'open' } })
    })
    await page.goto(app('/'))
    await rail(page, '看板').click()

    const botCard = page.getByRole('group', { name: 'Bot 负责的看板任务', exact: true })
    const prCard = page.getByRole('group', { name: '只有 PR 的看板任务', exact: true })
    await expect(botCard).toBeVisible()

    // Row 1: the Bot's own blob on top, the person's letter avatar, two agent marks, then +1.
    const group = botCard.locator('[data-slot="avatar-group"]')
    await expect(group.locator('[data-avatar]')).toHaveCount(4)
    await expect(group.locator('[data-avatar]').first()).toHaveAttribute('data-avatar', 'bot')
    await expect(group.locator('[data-avatar="member"]')).toHaveText('回')
    // Inside the assignee button the marks are presentational, so find them by their names.
    await expect(group.locator('[role="img"][aria-label="Claude Code"]')).toBeVisible()
    await expect(group.locator('[role="img"][aria-label="Codex"]')).toBeVisible()
    await expect(group.locator('[data-slot="avatar-group-count"]')).toHaveText('+1')
    const sizes = await group.locator('[data-avatar]').evaluateAll(items => items.map(item => Math.round(item.getBoundingClientRect().width)))
    expect(sizes).toEqual([18, 18, 18, 18])
    const layers = await group.locator('[data-avatar]').evaluateAll(items => items.map(item => Number(getComputedStyle(item.parentElement!).zIndex)))
    expect(layers).toEqual([...layers].sort((a, b) => b - a))
    await expect(group.locator('[data-avatar="bot"] svg').first()).toBeVisible()

    // A task with nobody on it draws no assignee placeholder.
    await expect(prCard.locator('[data-slot="avatar-group"]')).toHaveCount(0)

    // PR icons carry the state GitHub confirmed: merged violet, open green.
    await expect(botCard.getByRole('link', { name: /pull\/95$/ }).locator('svg')).toHaveClass(/text-info-foreground/)
    await expect(prCard.getByRole('link', { name: /pull\/96$/ }).locator('svg')).toHaveClass(/text-success-foreground/)

    // The due date is the seeded day, and overdue is red.
    const due = botCard.getByText('10月30日', { exact: true })
    await expect(due).toBeVisible()
    await expect(botCard.getByText('10月29日', { exact: true })).toHaveCount(0)
    await expect(due).toHaveClass(/text-destructive/)

    // The personal-task lock explains itself on hover.
    await botCard.getByLabel('个人任务', { exact: true }).hover()
    await expect(page.getByText('个人任务 · 只有你能看到', { exact: true })).toBeVisible()
  })
})
