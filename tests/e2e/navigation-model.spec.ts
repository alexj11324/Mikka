import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import type { Page } from '@playwright/test'
import { test, expect, register, app, rail, seedTask, openIssueFromSearch, conversationPill, hydrated } from './fixtures'

// R-82: one address says what is on screen, every move is a history entry,
// and back / forward step through it one move at a time without leaving Mikka.
// Each test below is one row of the navigation table in
// docs/design/decisions/2026-11-01-1320-navigation-model.md.

const chat = (page: Page) => page.getByRole('textbox', { name: '给 Coordinator 发消息', exact: true })
const board = (page: Page) => page.getByRole('region', { name: '任务看板', exact: true })
const taskTitle = (page: Page) => page.getByLabel('任务标题', { exact: true })
const query = (page: Page) => new URL(page.url()).searchParams

const closeTask = (page: Page) => page.getByRole('button', { name: '关闭任务详情', exact: true }).click()
/** The task page's first crumb: where the task was opened from. */
const originCrumb = (page: Page, name: string) => page.getByRole('navigation', { name: '当前位置', exact: true }).getByRole('button', { name, exact: true })
const pager = (page: Page) => page.getByRole('button', { name: '下一个任务', exact: true })

async function back(page: Page) {
  await page.goBack()
  // Back never leaves the app while there is a step inside it.
  expect(new URL(page.url()).pathname.startsWith(app('/'))).toBe(true)
}

test('rail pages are steps in history: back and forward walk them one at a time', async ({ page }) => {
  await register(page)
  await expect(chat(page)).toBeVisible()
  await rail(page, '看板').click()
  await expect(page).toHaveURL(url => url.searchParams.get('section') === 'all-issues')
  await rail(page, '建议').click()
  await expect(page).toHaveURL(url => url.searchParams.get('section') === 'suggestions')
  await rail(page, 'Artifact').click()
  await expect(page).toHaveURL(url => url.searchParams.get('section') === 'artifacts')

  await back(page)
  await expect(page).toHaveURL(url => url.searchParams.get('section') === 'suggestions')
  await expect(rail(page, '建议')).toHaveAttribute('aria-current', 'page')
  await back(page)
  await expect(board(page)).toBeVisible()
  await back(page)
  await expect(chat(page)).toBeVisible()
  expect(query(page).get('section')).toBeNull()

  await page.goForward()
  await expect(board(page)).toBeVisible()
  await page.reload()
  await expect(board(page)).toBeVisible()
})

test('switching bots is a step: back returns to the bot that was open', async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: '新建 Bot', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: '新建 Bot' })
  await dialog.getByLabel('名字', { exact: true }).fill('导航 Bot')
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(conversationPill(page)).toHaveText('导航 Bot')
  const botId = query(page).get('bot')
  expect(botId).toMatch(/^[0-9a-f-]{36}$/)

  const bots = page.getByRole('list', { name: 'Bot', exact: true })
  await bots.getByRole('button', { name: 'Coordinator', exact: true }).click()
  await expect(conversationPill(page)).toHaveText('Coordinator')
  // The Coordinator's chat is the bare address.
  expect([...query(page).keys()]).toEqual([])

  await back(page)
  await expect(conversationPill(page)).toHaveText('导航 Bot')
  expect(query(page).get('bot')).toBe(botId)
  await page.goForward()
  await expect(conversationPill(page)).toHaveText('Coordinator')

  // A pasted bot link opens that bot's chat.
  await page.goto(app(`/?bot=${botId}`))
  await expect(conversationPill(page)).toHaveText('导航 Bot')
})

test('a task opened from the chat is its own page; back returns to the chat, forward reopens it', async ({ page }) => {
  await register(page)
  const title = `导航任务 ${randomUUID()}`
  const issueId = await seedTask(page, title)
  await page.reload()
  await hydrated(chat(page))

  await openIssueFromSearch(page, title)
  await expect(taskTitle(page)).toHaveValue(title)
  expect(query(page).get('issue')).toBe(issueId)

  await back(page)
  await expect(chat(page)).toBeVisible()
  await expect(taskTitle(page)).toHaveCount(0)
  await page.goForward()
  await expect(taskTitle(page)).toHaveValue(title)

  // ✕ steps back to the chat it was opened from, so forward reopens the task.
  await closeTask(page)
  await expect(chat(page)).toBeVisible()
  expect(query(page).get('issue')).toBeNull()
  await page.goForward()
  await expect(taskTitle(page)).toHaveValue(title)
})

test('board → task → back lands on the board; rail → back after a task lands on the task', async ({ page }) => {
  await register(page)
  const title = `看板任务 ${randomUUID()}`
  await seedTask(page, title)
  await page.goto(app('/?section=all-issues'))
  await hydrated(rail(page, '看板'))
  await board(page).getByText(title, { exact: true }).click()
  await expect(taskTitle(page)).toHaveValue(title)
  expect(query(page).get('section')).toBe('all-issues')

  await rail(page, 'Artifact').click()
  await expect(page).toHaveURL(url => url.searchParams.get('section') === 'artifacts' && !url.searchParams.has('issue'))
  await back(page)
  await expect(taskTitle(page)).toHaveValue(title)
  await back(page)
  await expect(board(page)).toBeVisible()
  await expect(taskTitle(page)).toHaveCount(0)
})

test('a link opened from outside the window\'s own clicks (a desktop notification) shows its task', async ({ page }) => {
  await register(page)
  const title = `通知任务 ${randomUUID()}`
  const issueId = await seedTask(page, title)
  await page.reload()
  // A notification reaches a running app, not one still hydrating.
  await hydrated(chat(page))
  // What openAppLink does: a new entry, then the same back/forward path.
  await page.evaluate(href => {
    window.history.pushState(window.history.state, '', href)
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
  }, app(`/?issue=${issueId}`))
  await expect(taskTitle(page)).toHaveValue(title)
  await back(page)
  await expect(chat(page)).toBeVisible()
})

// ── Threads (PR 2): one place, the right column, from every entry point ──────

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Navigation acceptance requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

const THREAD = 'Speed up the home page'

/**
 * The Coordinator turn a dispatch_run leaves behind (as thread-cards.spec.ts
 * seeds it), plus a reply that names the thread and its task as chips. With
 * `otherBot`, the run belongs to another bot of this person instead.
 * Only CI's isolated disposable database is touched.
 */
async function seedThread(email: string, issueTitle: string, { otherBot }: { otherBot?: string } = {}) {
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string; workspaceId: string }>('SELECT u.id, m."workspaceId" FROM "user" u JOIN mikka_workspace_members m ON m."userId" = u.id WHERE u.email = $1 LIMIT 1', [email])
    const { rows: [issue] } = await pool.query<{ id: string }>('SELECT id FROM issues WHERE "userId" = $1 AND title = $2', [user.id, issueTitle])
    let botId: string | null = null
    if (otherBot) {
      botId = randomUUID()
      await pool.query('INSERT INTO bots (id, "ownerId", "workspaceId", name, color, shape) VALUES ($1, $2, $3, $4, $5, $6)', [botId, user.id, user.workspaceId, otherBot, 'rose', 'nuage'])
    } else {
      botId = (await pool.query<{ botId: string }>('SELECT "botId" FROM coordinator_bots WHERE "ownerId" = $1', [user.id])).rows[0]?.botId ?? null
    }
    const agentId = randomUUID()
    const runId = randomUUID()
    await pool.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1, $2, $3, $4)', [agentId, user.id, 'codex', 'Mikka Frontend'])
    await pool.query('INSERT INTO agent_runs (id, "userId", "issueId", "agentId", "botId", status, prompt) VALUES ($1, $2, $3, $4, $5, $6, $7)', [runId, user.id, issue.id, agentId, botId, 'running', `${THREAD}\nMeasure first.`])
    await pool.query('INSERT INTO run_chunks (id, "runId", seq, chunk) VALUES ($1, $2, 1, $3)', [randomUUID(), runId, JSON.stringify({ type: 'text-delta', id: 't1', delta: 'Home page loads in 3.8s.' })])
    if (!otherBot) {
      const messages = [
        { role: 'user', content: 'The home page is slow' },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: runId, toolName: 'dispatch_run', input: {} }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: runId, toolName: 'dispatch_run', output: { type: 'json', value: { runId, status: 'queued' } } }] },
        { role: 'assistant', content: [{ type: 'text', text: `线程 [[run:${runId}]] 在做 [[issue:${issue.id}]]。` }] },
      ]
      for (const [index, message] of messages.entries()) {
        await pool.query('INSERT INTO coordinator_messages (id, "userId", "botId", position, message) VALUES ($1, $2, (SELECT "botId" FROM coordinator_bots WHERE "ownerId" = $2), $3, $4)', [randomUUID(), user.id, index + 1, JSON.stringify(message)])
      }
    }
    return { runId, issueId: issue.id }
  } finally { await pool.end() }
}

const column = (page: Page) => page.locator('[data-slot="thread-column"]')
const threadIn = (page: Page) => column(page).getByRole('region', { name: THREAD, exact: true })

async function chatWithThread(page: Page) {
  const { email } = await register(page)
  const title = `线程任务 ${randomUUID()}`
  await seedTask(page, title)
  const seeded = await seedThread(email, title)
  await page.reload()
  await hydrated(chat(page))
  return { title, ...seeded }
}

/** The thread is open beside the chat: its conversation on the right, the chat still in the centre, and its address. */
async function expectThreadBesideChat(page: Page, runId: string) {
  await expect(threadIn(page).getByRole('list', { name: '线程对话' })).toContainText('Home page loads in 3.8s.')
  await expect(chat(page)).toBeVisible()
  expect(query(page).get('thread')).toBe(runId)
}

test('a thread card opens the thread beside the chat; back closes it, forward and reload keep it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const { runId } = await chatWithThread(page)
  await page.getByRole('button', { name: `打开线程 ${THREAD}`, exact: true }).first().click()
  await expectThreadBesideChat(page, runId)
  // The bot that dispatched it is named in the thread (R-78, R-82).
  await expect(threadIn(page)).toContainText('Coordinator 派出线程')

  await back(page)
  await expect(column(page)).toHaveCount(0)
  await expect(chat(page)).toBeVisible()
  await page.goForward()
  await expectThreadBesideChat(page, runId)
  await page.reload()
  await expectThreadBesideChat(page, runId)

  // A pasted thread link opens the same view.
  await page.goto(app(`/?thread=${runId}`))
  await expectThreadBesideChat(page, runId)
})

test('the thread chip and the right panel\'s 线程 row open the same thread column', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const { runId } = await chatWithThread(page)
  const reply = page.getByRole('region', { name: 'Coordinator', exact: true })

  await reply.getByRole('button', { name: `打开线程：${THREAD}`, exact: true }).click()
  await expectThreadBesideChat(page, runId)
  await threadIn(page).getByRole('button', { name: '关闭线程', exact: true }).click()
  await expect(column(page)).toHaveCount(0)

  const panel = page.getByRole('complementary', { name: '右栏', exact: true })
  await panel.getByRole('tab', { name: '线程', exact: true }).click()
  await panel.getByRole('button').filter({ hasText: /线程任务/ }).first().click()
  await expectThreadBesideChat(page, runId)
  await back(page)
  await expect(column(page)).toHaveCount(0)
})

test('打开任务 from a thread opens the task page with the thread still beside it; back returns to the chat and thread', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const { title, issueId, runId } = await chatWithThread(page)
  await page.getByRole('button', { name: `打开线程 ${THREAD}`, exact: true }).first().click()
  await expectThreadBesideChat(page, runId)
  await threadIn(page).getByRole('button', { name: '打开任务', exact: true }).click()
  await expect(taskTitle(page)).toHaveValue(title)
  expect(query(page).get('issue')).toBe(issueId)
  expect(query(page).get('thread')).toBe(runId)
  await expect(page.getByRole('region', { name: THREAD, exact: true }).getByRole('list', { name: '线程对话' })).toContainText('Home page loads in 3.8s.')

  await back(page)
  await expectThreadBesideChat(page, runId)
})

test('a task page\'s 线程 row opens the thread in the task\'s right column; back closes it and keeps the task', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const { title, issueId, runId } = await chatWithThread(page)
  await page.goto(app(`/?issue=${issueId}`))
  await expect(taskTitle(page)).toHaveValue(title)
  await page.getByRole('region', { name: /^线程/ }).getByRole('button', { name: `打开线程 ${THREAD}`, exact: true }).click()
  const panel = page.getByRole('region', { name: THREAD, exact: true })
  await expect(panel.getByRole('list', { name: '线程对话' })).toContainText('Home page loads in 3.8s.')
  expect(query(page).get('thread')).toBe(runId)
  await back(page)
  await expect(panel).toHaveCount(0)
  await expect(taskTitle(page)).toHaveValue(title)
})

test('全部线程: another bot\'s thread opens beside the current chat, naming the bot that dispatched it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const { email } = await register(page)
  const title = `别的 Bot 任务 ${randomUUID()}`
  await seedTask(page, title)
  const { runId } = await seedThread(email, title, { otherBot: '写作助手' })
  await page.reload()
  await hydrated(chat(page))
  const panel = page.getByRole('complementary', { name: '右栏', exact: true })
  await panel.getByRole('tab', { name: '全部线程', exact: true }).click()
  await panel.getByRole('button').filter({ hasText: /别的 Bot 任务/ }).first().click()
  await expectThreadBesideChat(page, runId)
  await expect(conversationPill(page)).toHaveText('Coordinator')
  await expect(threadIn(page)).toContainText('写作助手 派出线程')
})

// ── The task page's origin (PR 4): crumb, ✕, ↑↓, and addresses that rewrite themselves ──

test('chat → thread → 打开任务: the first crumb names the chat; ✕ brings back the chat with its thread, no ↑↓', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const { title, runId } = await chatWithThread(page)
  await page.getByRole('button', { name: `打开线程 ${THREAD}`, exact: true }).first().click()
  await expectThreadBesideChat(page, runId)
  await threadIn(page).getByRole('button', { name: '打开任务', exact: true }).click()
  await expect(taskTitle(page)).toHaveValue(title)
  // The address names the chat it came from, so a reload or a copied link knows it too.
  expect(query(page).get('section')).toBe('coordinator')
  // The thread beside it narrows the page, so the first crumb is folded into 更多位置.
  await page.getByRole('button', { name: '更多位置', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Coordinator', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(pager(page)).toHaveCount(0)

  await closeTask(page)
  await expectThreadBesideChat(page, runId)
  expect(query(page).get('issue')).toBeNull()
})

test('a pasted chat task link: ✕ opens that chat, not the board; a bare task link closes onto the board', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  await register(page)
  const title = `来源任务 ${randomUUID()}`
  const issueId = await seedTask(page, title)

  await page.goto(app(`/?section=coordinator&issue=${issueId}`))
  await expect(taskTitle(page)).toHaveValue(title)
  await expect(originCrumb(page, 'Coordinator')).toBeVisible()
  await hydrated(taskTitle(page))
  await closeTask(page)
  await expect(chat(page)).toBeVisible()
  expect([...query(page).keys()]).toEqual([])

  await page.goto(app(`/?issue=${issueId}`))
  await expect(originCrumb(page, '看板')).toBeVisible()
  await hydrated(taskTitle(page))
  await originCrumb(page, '看板').click()
  await expect(board(page)).toBeVisible()
})

test('a bot\'s task link names the bot; ✕ opens that bot\'s chat', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  await register(page)
  const title = `Bot 来源任务 ${randomUUID()}`
  const issueId = await seedTask(page, title)
  await page.getByRole('button', { name: '新建 Bot', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: '新建 Bot' })
  await dialog.getByLabel('名字', { exact: true }).fill('来源 Bot')
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(conversationPill(page)).toHaveText('来源 Bot')
  const botId = query(page).get('bot')

  await page.goto(app(`/?bot=${botId}&issue=${issueId}`))
  await expect(taskTitle(page)).toHaveValue(title)
  await expect(originCrumb(page, '来源 Bot')).toBeVisible()
  await hydrated(taskTitle(page))
  await closeTask(page)
  await expect(conversationPill(page)).toHaveText('来源 Bot')
  expect(query(page).get('bot')).toBe(botId)
})

test('board → task: ↑↓ step through the board and the crumb says 看板; ⌘K from the chat: no ↑↓', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  await register(page)
  const first = `看板翻页 A ${randomUUID()}`
  const second = `看板翻页 B ${randomUUID()}`
  await seedTask(page, first)
  await seedTask(page, second)
  await page.goto(app('/?section=all-issues'))
  await hydrated(rail(page, '看板'))
  await board(page).getByText(first, { exact: true }).click()
  await expect(taskTitle(page)).toHaveValue(first)
  await expect(originCrumb(page, '看板')).toBeVisible()
  await expect(pager(page)).toBeVisible()

  await closeTask(page)
  await expect(board(page)).toBeVisible()
  await rail(page, '主页').click()
  await hydrated(chat(page))
  await openIssueFromSearch(page, second)
  await expect(taskTitle(page)).toHaveValue(second)
  await expect(originCrumb(page, 'Coordinator')).toBeVisible()
  await expect(pager(page)).toHaveCount(0)
})

test('an unknown section or bot in the address rewrites itself to what is shown, without a new entry', async ({ page }) => {
  await register(page)
  await page.goto(app('/?section=nope'))
  await expect(chat(page)).toBeVisible()
  await expect(page).toHaveURL(url => !url.searchParams.has('section'))
  const entries = await page.evaluate(() => window.history.length)

  await page.goto(app(`/?bot=${randomUUID()}`))
  await expect(conversationPill(page)).toHaveText('Coordinator')
  await expect(page).toHaveURL(url => !url.searchParams.has('bot'))
  expect(await page.evaluate(() => window.history.length)).toBe(entries + 1)
})
