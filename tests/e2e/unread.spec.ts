import type { Page } from '@playwright/test'
import { test, expect, register } from './fixtures'

// MIK-8. Backend's /api/conversations/:id/read is not live yet, so the UI reads its
// position from the localStorage-backed mock source (lib/conversation-reads.ts); tests
// seed that key. Messages come from rewriting only the `getCoordinatorChat` server
// action response (same approach as working-status.spec.ts); no production code changes.
const READ_KEY = 'mikka:mock-conversation-read:coordinator'
type Item = { position: number; from: 'person' | 'coordinator'; text: string; tools: string[]; createdAt: string }
const message = (position: number, from: Item['from'] = 'coordinator'): Item => ({ position, from, text: `消息 ${position} ${'内容 '.repeat(40)}`, tools: [], createdAt: '2026-10-22T00:00:00.000Z' })
const range = (from: number, to: number, who: Item['from'] = 'coordinator') => Array.from({ length: to - from + 1 }, (_, index) => message(from + index, who))

const ITEMS = /"items"\s*:\s*\[[^\]]*\]/

async function mockChat(page: Page, initial: Item[]) {
  const state = { items: initial, rewrites: 0, actionId: null as string | null }
  await page.route('**/*', async route => {
    const request = route.request()
    const actionId = request.headers()['next-action']
    if (request.method() !== 'POST' || !actionId) return route.fallback()
    if (state.actionId && actionId !== state.actionId) return route.fallback()
    if (!state.actionId && (request.postData() ?? '').trim() !== '[]') return route.fallback()
    const response = await route.fetch()
    const body = await response.text()
    if (!ITEMS.test(body) || !/"working"\s*:/.test(body)) return route.fulfill({ response, body })
    state.actionId = actionId
    state.rewrites++
    return route.fulfill({ response, body: body.replace(ITEMS, `"items":${JSON.stringify(state.items)}`).replace(/"working"\s*:\s*true/g, '"working":false') })
  })
  return state
}

async function seedRead(page: Page, position: number | null) {
  await page.addInitScript(([key, value]) => {
    if (value === null) localStorage.removeItem(key as string)
    else localStorage.setItem(key as string, JSON.stringify({ lastReadMessageId: String(value), lastReadPosition: value, unreadCount: 0 }))
  }, [READ_KEY, position] as const)
}

async function openCoordinator(page: Page) {
  await page.getByRole('button', { name: 'Coordinator', exact: true }).first().click()
  await expect(page.getByRole('region', { name: 'Coordinator' })).toBeVisible()
}

const divider = (page: Page) => page.locator('[data-unread-divider]')
const topPill = (page: Page) => page.locator('[data-unread-pill="up"]')
const bottomPill = (page: Page) => page.locator('[data-unread-pill="down"]')
const viewport = (page: Page) => page.locator('[data-slot="message-scroller-viewport"]')
const storedPosition = (page: Page) => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null')?.lastReadPosition ?? null, READ_KEY)


test('未读：首次进入没有已读记录时不显示分隔线', async ({ page }) => {
  const chat = await mockChat(page, range(1, 6))
  await seedRead(page, null)
  await register(page)
  await openCoordinator(page)
  await expect(page.getByText('消息 6', { exact: false })).toBeVisible()
  await expect(divider(page)).toHaveCount(0)
  expect(chat.rewrites, '必须真正改写到 getCoordinatorChat').toBeGreaterThan(0)
})

test('未读：全部已读时不显示分隔线', async ({ page }) => {
  const chat = await mockChat(page, range(1, 6))
  await seedRead(page, 6)
  await register(page)
  await openCoordinator(page)
  await expect(page.getByText('消息 6', { exact: false })).toBeVisible()
  await expect(divider(page)).toHaveCount(0)
  expect(chat.rewrites).toBeGreaterThan(0)
})

test('未读：自己发的消息不产生分隔线', async ({ page }) => {
  await mockChat(page, [...range(1, 3), message(4, 'person')])
  await seedRead(page, 3)
  await register(page)
  await openCoordinator(page)
  await expect(page.getByText('消息 4', { exact: false })).toBeVisible()
  await expect(divider(page)).toHaveCount(0)
})

test('未读：有未读时显示「新」分隔线，停在视口上部约三分之一', async ({ page }) => {
  await mockChat(page, range(1, 40))
  await seedRead(page, 10)
  await register(page)
  await openCoordinator(page)
  await expect(divider(page)).toHaveCount(1)
  await expect(divider(page)).toBeInViewport()
  const [line, box] = await Promise.all([divider(page).boundingBox(), viewport(page).boundingBox()])
  expect(line && box && (line.y - box.y) / box.height).toBeLessThan(0.5)
})

test('未读：分隔线在可视区域上方时出现顶部按钮，点一下回到分隔线', async ({ page }) => {
  await mockChat(page, range(1, 40))
  await seedRead(page, 10)
  await register(page)
  await openCoordinator(page)
  await expect(divider(page)).toBeInViewport()
  await expect(topPill(page)).toHaveCount(0)
  await viewport(page).evaluate(element => element.scrollTo({ top: element.scrollHeight }))
  await expect(topPill(page)).toBeVisible()
  await expect(topPill(page)).toContainText('30 条新消息')
  await topPill(page).getByRole('button', { name: /条新消息/ }).click()
  await expect(divider(page)).toBeInViewport()
  await expect(topPill(page)).toHaveCount(0)
})

test('未读：顶部按钮点 × 只关掉', async ({ page }) => {
  await mockChat(page, range(1, 40))
  await seedRead(page, 10)
  await register(page)
  await openCoordinator(page)
  await viewport(page).evaluate(element => element.scrollTo({ top: element.scrollHeight }))
  await topPill(page).getByRole('button', { name: '关闭' }).click()
  await expect(topPill(page)).toHaveCount(0)
  await expect(divider(page)).not.toBeInViewport()
})

test('未读：不在底部时有新消息进来出现底部按钮，点击滚到最新一条并清零', async ({ page }) => {
  const chat = await mockChat(page, range(1, 30))
  await seedRead(page, 30)
  await register(page)
  await openCoordinator(page)
  await expect(page.getByText('消息 30', { exact: false })).toBeInViewport()
  await viewport(page).evaluate(element => element.scrollTo({ top: 0 }))
  chat.items = [...chat.items, ...range(31, 33)]
  // Coordinator polls every 10s when idle.
  await expect(bottomPill(page)).toContainText('3 条新消息', { timeout: 15_000 })
  await bottomPill(page).getByRole('button', { name: /条新消息/ }).click()
  await expect(page.getByText('消息 33', { exact: false })).toBeInViewport()
  await expect(bottomPill(page)).toHaveCount(0)
})

test('未读：手动滚到底部时底部按钮自动消失，计数归零', async ({ page }) => {
  const chat = await mockChat(page, range(1, 30))
  await seedRead(page, 30)
  await register(page)
  await openCoordinator(page)
  await viewport(page).evaluate(element => element.scrollTo({ top: 0 }))
  chat.items = [...chat.items, ...range(31, 32)]
  await expect(bottomPill(page)).toBeVisible({ timeout: 15_000 })
  await viewport(page).evaluate(element => element.scrollTo({ top: element.scrollHeight }))
  await expect(bottomPill(page)).toHaveCount(0)
  chat.items = [...chat.items, ...range(33, 33)]
  await page.waitForTimeout(11_000)
  await expect(bottomPill(page)).toHaveCount(0)
})

test('未读：已读位置按可视区域最后一条上报（节流 2s），页面隐藏时立即 flush', async ({ page }) => {
  await mockChat(page, range(1, 40))
  await seedRead(page, 10)
  await register(page)
  await openCoordinator(page)
  await expect(divider(page)).toBeInViewport()
  await expect.poll(() => storedPosition(page)).toBeGreaterThan(10)
  const visible = await storedPosition(page)
  expect(visible).toBeLessThan(40)
  await viewport(page).evaluate(element => element.scrollTo({ top: element.scrollHeight }))
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => storedPosition(page), { timeout: 1000 }).toBe(40)
})

test('未读：两个页面同步且已读位置不回退', async ({ page, context }) => {
  await mockChat(page, range(1, 40))
  await seedRead(page, 10)
  await register(page)
  await openCoordinator(page)
  await viewport(page).evaluate(element => element.scrollTo({ top: element.scrollHeight }))
  await expect.poll(() => storedPosition(page), { timeout: 5000 }).toBe(40)
  const other = await context.newPage()
  await mockChat(other, range(1, 40))
  await other.goto(page.url())
  await openCoordinator(other)
  await viewport(other).evaluate(element => element.scrollTo({ top: 0 }))
  await other.waitForTimeout(2500)
  expect(await storedPosition(other)).toBe(40)
  await expect(divider(other)).toHaveCount(0)
})
