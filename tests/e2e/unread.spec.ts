import type { BrowserContext, Page } from '@playwright/test'
import { test, expect, register, app } from './fixtures'

// MIK-8. Messages come from rewriting only the `getCoordinatorChat` server action response
// (same approach as working-status.spec.ts), so their positions aren't real rows. The read API
// is answered here with the server's rules (lib/conversation-reads-store.ts): forward-only,
// 422 for a message the chat doesn't have. One store per browser context, so two pages share it.
type Item = { position: number; from: 'person' | 'coordinator'; text: string; tools: string[]; threads: string[]; createdAt: string; pending?: true }
const message = (position: number, from: Item['from'] = 'coordinator'): Item => ({ position, from, text: `消息 ${position} ${'内容 '.repeat(40)}`, tools: [], threads: [], createdAt: '2026-10-22T00:00:00.000Z' })
const range = (from: number, to: number, who: Item['from'] = 'coordinator') => Array.from({ length: to - from + 1 }, (_, index) => message(from + index, who))

const chats = new WeakMap<BrowserContext, { items: Item[] }>()
const ITEMS = /"items"\s*:\s*\[[^\]]*\]/

async function mockChat(page: Page, initial: Item[]) {
  const state = { items: initial, rewrites: 0, actionId: null as string | null }
  chats.set(page.context(), state)
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

type ReadState = { lastReadPosition: number | null; posts: number; simulateStatus?: number }
const reads = new WeakMap<BrowserContext, ReadState>()

async function seedRead(page: Page, position: number | null, extra: { simulateStatus?: number } = {}) {
  const context = page.context()
  const existing = reads.get(context)
  if (existing) return existing
  const state: ReadState = { lastReadPosition: position, posts: 0, ...extra }
  reads.set(context, state)
  const answer = () => ({ lastReadMessageId: state.lastReadPosition === null ? null : String(state.lastReadPosition), lastReadPosition: state.lastReadPosition, unreadCount: 0 })
  await context.route('**/api/conversations/coordinator/read', async route => {
    const request = route.request()
    if (request.method() === 'GET') return route.fulfill({ json: answer() })
    state.posts++
    if (state.simulateStatus) return route.fulfill({ status: state.simulateStatus, json: { error: 'simulated' } })
    const messageId = (JSON.parse(request.postData() ?? '{}') as { messageId?: string }).messageId ?? ''
    const target = Number(messageId)
    if (!/^\d+$/.test(messageId) || !chats.get(context)?.items.some(item => item.position === target && !item.pending)) return route.fulfill({ status: 422, json: { error: 'messageNotFound' } })
    state.lastReadPosition = Math.max(state.lastReadPosition ?? 0, target)
    return route.fulfill({ json: answer() })
  })
  return state
}
const storedPosts = (page: Page) => reads.get(page.context())?.posts ?? 0

async function openCoordinator(page: Page) {
  await page.getByRole('button', { name: 'Coordinator', exact: true }).first().click()
  await expect(page.getByRole('region', { name: 'Coordinator', exact: true })).toBeVisible()
}

// The sidebar previews the last message too, so look inside the conversation only.
const conversation = (page: Page) => page.getByRole('region', { name: '与 Coordinator 的对话', exact: true })
const divider = (page: Page) => page.locator('[data-unread-divider]')
const topPill = (page: Page) => page.locator('[data-unread-pill="up"]')
const bottomPill = (page: Page) => page.locator('[data-unread-pill="down"]')
const viewport = (page: Page) => page.locator('[data-slot="message-scroller-viewport"]')
const storedPosition = (page: Page) => reads.get(page.context())?.lastReadPosition ?? null


test('未读：首次进入没有已读记录时不显示分隔线', async ({ page }) => {
  const chat = await mockChat(page, range(1, 6))
  await seedRead(page, null)
  await register(page)
  await openCoordinator(page)
  await expect(conversation(page).getByText('消息 6', { exact: false })).toBeVisible()
  await expect(divider(page)).toHaveCount(0)
  expect(chat.rewrites, '必须真正改写到 getCoordinatorChat').toBeGreaterThan(0)
})

test('未读：全部已读时不显示分隔线', async ({ page }) => {
  const chat = await mockChat(page, range(1, 6))
  await seedRead(page, 6)
  await register(page)
  await openCoordinator(page)
  await expect(conversation(page).getByText('消息 6', { exact: false })).toBeVisible()
  await expect(divider(page)).toHaveCount(0)
  expect(chat.rewrites).toBeGreaterThan(0)
})

test('未读：自己发的消息不产生分隔线', async ({ page }) => {
  await mockChat(page, [...range(1, 3), message(4, 'person')])
  await seedRead(page, 3)
  await register(page)
  await openCoordinator(page)
  await expect(conversation(page).getByText('消息 4', { exact: false })).toBeVisible()
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
  await expect(divider(page)).toBeInViewport()
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
  await expect(conversation(page).getByText('消息 30', { exact: false })).toBeInViewport()
  await viewport(page).evaluate(element => element.scrollTo({ top: 0 }))
  chat.items = [...chat.items, ...range(31, 33)]
  // Coordinator polls every 10s when idle.
  await expect(bottomPill(page)).toContainText('3 条新消息', { timeout: 15_000 })
  await bottomPill(page).getByRole('button', { name: /条新消息/ }).click()
  await expect(conversation(page).getByText('消息 33', { exact: false })).toBeInViewport()
  await expect(bottomPill(page)).toHaveCount(0)
})

test('未读：手动滚到底部时底部按钮自动消失，计数归零', async ({ page }) => {
  const chat = await mockChat(page, range(1, 30))
  await seedRead(page, 30)
  await register(page)
  await openCoordinator(page)
  await expect(conversation(page).getByText('消息 30', { exact: false })).toBeInViewport()
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
  // Let the scroll event land (well inside the 2s throttle window), then hide: flush must send now.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
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
  await expect(divider(page)).toBeInViewport()
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

test('未读：可视区域最后一条是未落库的合成消息时，上报它前面最后一条已持久化消息', async ({ page }) => {
  await mockChat(page, [...range(1, 30), { ...message(31, 'person'), pending: true }])
  await seedRead(page, 10)
  await register(page)
  await openCoordinator(page)
  await expect.poll(() => storedPosition(page)).toBeGreaterThan(10)
  await viewport(page).evaluate(element => element.scrollTo({ top: element.scrollHeight }))
  await expect(conversation(page).getByText('消息 31', { exact: false })).toBeInViewport()
  await expect.poll(() => storedPosition(page), { timeout: 5000 }).toBe(30)
  await page.waitForTimeout(2500)
  expect(await storedPosition(page)).toBe(30)
})

for (const [status, reason] of [[422, 'Unprocessable Entity'], [403, 'Forbidden']] as const) {
  test.describe(`POST ${status}`, () => {
    // The one failed POST is logged by the browser; anything beyond it means a retry or a real error.
    test.use({ expectedConsoleErrors: [{ path: app('/api/conversations/coordinator/read'), message: `Failed to load resource: the server responded with a status of ${status} (${reason})` }] })
    test(`未读：POST /read 返回 ${status} 时静默降级，界面无报错且不重试`, async ({ page }) => {
      await mockChat(page, range(1, 40))
      await seedRead(page, 10, { simulateStatus: status })
      await register(page)
      await openCoordinator(page)
      await expect(divider(page)).toBeInViewport()
      await expect.poll(() => storedPosts(page), { timeout: 5000 }).toBeGreaterThan(0)
      for (const top of [0.5, 0.8, 1]) {
        await viewport(page).evaluate((element, ratio) => element.scrollTo({ top: element.scrollHeight * ratio }), top)
        await page.waitForTimeout(1500)
      }
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await page.waitForTimeout(500)
      expect(await storedPosts(page), '失败后本次访问不再发送').toBe(1)
      expect(await storedPosition(page)).toBe(10)
      await expect(divider(page)).toHaveCount(1)
      await expect(page.getByRole('alert').filter({ hasText: /失败|错误|出错|error|failed/i })).toHaveCount(0)
    })
  })
}
