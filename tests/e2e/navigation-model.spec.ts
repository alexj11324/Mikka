import { randomUUID } from 'node:crypto'
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

  // Closing the task is a step too, and back reopens it.
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click()
  await expect(chat(page)).toBeVisible()
  await back(page)
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
