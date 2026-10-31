import type { Page } from '@playwright/test'
import { test, expect, register } from './fixtures'

// Two messages sent back to back, then both replies. The server answers the
// chat the way lib/coordinator/store.ts does: a message still in the inbox is
// `pending` at the next free position, and moves when a reply is stored ahead
// of it. Only the `getCoordinatorChat` response is rewritten (see unread.spec.ts).
type Item = { id?: string; position: number; from: 'person' | 'coordinator'; text: string; tools: string[]; threads: string[]; artifacts: string[]; createdAt: string; pending?: true }
const item = (position: number, from: Item['from'], text: string, pending = false): Item => ({ ...(pending ? { pending: true as const } : { id: `m-${position}` }), position, from, text, tools: [], threads: [], artifacts: [], createdAt: '2026-10-30T00:00:00.000Z' })
const history = Array.from({ length: 16 }, (_, index) => item(index + 1, index % 2 ? 'coordinator' : 'person', `历史 ${index + 1} ${'内容 '.repeat(index % 2 ? 60 : 8)}`))
const FIRST = 'MIKKA_DEFAULT_OK_570'
const SECOND = 'MIKKA_BYOK_OK_571'
const REPLY_FIRST = `回复一 ${'第一条的回答 '.repeat(30)}`
const REPLY_SECOND = `回复二 ${'第二条的回答 '.repeat(30)}`

const ITEMS = /"items"\s*:\s*\[[^\]]*\]/

async function mockChat(page: Page) {
  const state = { items: history, working: false, error: null as string | null, served: 0, welcomes: 0, actionId: null as string | null }
  await page.route('**/*', async route => {
    const request = route.request()
    const actionId = request.headers()['next-action']
    if (request.method() !== 'POST' || !actionId) return route.fallback()
    if (state.actionId && actionId !== state.actionId) {
      if ((request.postData() ?? '').trim() !== '[]') return route.fallback()
      const response = await route.fetch()
      const body = await response.text()
      if (/"queued"\s*:\s*(true|false)/.test(body)) state.welcomes++
      return route.fulfill({ response, body })
    }
    if (!state.actionId && (request.postData() ?? '').trim() !== '[]') return route.fallback()
    const response = await route.fetch()
    const body = await response.text()
    if (!ITEMS.test(body) || !/"working"\s*:/.test(body)) return route.fulfill({ response, body })
    state.actionId = actionId
    state.served++
    return route.fulfill({ response, body: body.replace(ITEMS, `"items":${JSON.stringify(state.items)}`).replace(/"working"\s*:\s*(true|false)/, `"working":${state.working}`).replace(/"error"\s*:\s*(null|"(?:[^"\\]|\\.)*")/, `"error":${JSON.stringify(state.error)}`).replace(/"enabled"\s*:\s*false/, '"enabled":true') })
  })
  await page.context().route('**/api/conversations/coordinator/read', route => route.fulfill({ json: { lastReadMessageId: null, lastReadPosition: null, unreadCount: 0 } }))
  return state
}

const viewport = (page: Page) => page.locator('[data-slot="message-scroller-viewport"]')
const conversation = (page: Page) => page.getByRole('region', { name: '与 Coordinator 的对话', exact: true })

test('a failed hidden welcome does not enqueue another welcome on mount or poll', async ({ page }) => {
  const chat = await mockChat(page)
  chat.items = []
  chat.error = 'wake_exhausted'
  await register(page)
  await page.getByRole('button', { name: 'Coordinator', exact: true }).first().click()
  await expect(page.getByRole('alert').filter({ hasText: '回复重试已停止' })).toBeVisible()
  const served = chat.served
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => chat.served, { timeout: 15000 }).toBeGreaterThan(served)
  expect(chat.welcomes).toBe(0)
})

test('an unacknowledged wake keeps the message, stops the spinner and recovers through polling', async ({ page }) => {
  const chat = await mockChat(page)
  chat.items = [...history, item(17, 'person', FIRST, true)]
  chat.error = 'wake_start_unconfirmed'
  await register(page)
  await page.getByRole('button', { name: 'Coordinator', exact: true }).first().click()
  await expect(conversation(page).getByText(FIRST, { exact: true })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: '回复启动未确认' })).toBeVisible()
  await expect(conversation(page).getByText('Coordinator 正在处理…')).toHaveCount(0)
  chat.error = 'wake_exhausted'
  await expect(page.getByRole('alert').filter({ hasText: '回复重试已停止' })).toBeVisible({ timeout: 15000 })
  chat.items = [...history, item(17, 'person', FIRST), item(18, 'coordinator', REPLY_FIRST)]
  chat.error = null
  await expect(conversation(page).getByText('回复一', { exact: false })).toBeVisible({ timeout: 15000 })
  await expect(page.getByRole('alert').filter({ hasText: '回复重试已停止' })).toHaveCount(0)
})

/** Records, every frame, the viewport's scrollTop and the order of the messages on screen. */
async function record(page: Page) {
  await page.evaluate(() => {
    const frames: { step: string; top: number; order: string[] }[] = []
    Object.assign(window, { __chatFrames: frames })
    const tick = () => {
      const viewport = document.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
      if (viewport) frames.push({ step: (window as unknown as { __chatStep?: string }).__chatStep ?? 'open', top: Math.round(viewport.scrollTop), order: [...viewport.querySelectorAll<HTMLElement>('[data-slot="message"]')].map(node => (node.textContent ?? '').trim().slice(0, 24)) })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}
const frames = (page: Page) => page.evaluate(() => (window as unknown as { __chatFrames: { step: string; top: number; order: string[] }[] }).__chatFrames)

/** The served chat reaches `items`; waits for the next poll to put it on screen. */
async function serve(page: Page, state: Awaited<ReturnType<typeof mockChat>>, items: Item[], working: boolean, shown: string) {
  state.items = items
  state.working = working
  const before = state.served
  await page.evaluate(step => Object.assign(window, { __chatStep: step }), shown)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => state.served, { timeout: 15000 }).toBeGreaterThan(before)
  await expect(conversation(page).getByText(shown, { exact: false }).last()).toBeAttached()
}

test('two messages back to back: nothing reorders, no jump while replies arrive, the last reply sits above the composer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const chat = await mockChat(page)
  await register(page)
  await page.getByRole('button', { name: 'Coordinator', exact: true }).first().click()
  await expect(conversation(page).getByText('历史 16', { exact: false })).toBeVisible()
  await record(page)

  const last = history.length
  await serve(page, chat, [...history, item(last + 1, 'person', FIRST, true)], true, FIRST)
  await serve(page, chat, [...history, item(last + 1, 'person', FIRST, true), item(last + 2, 'person', SECOND, true)], true, SECOND)
  // The first reply is stored: the second message, still in the inbox, moves behind it.
  await serve(page, chat, [...history, item(last + 1, 'person', FIRST), item(last + 2, 'coordinator', REPLY_FIRST), item(last + 3, 'person', SECOND, true)], true, '回复一')
  await serve(page, chat, [...history, item(last + 1, 'person', FIRST), item(last + 2, 'coordinator', REPLY_FIRST), item(last + 3, 'person', SECOND), item(last + 4, 'coordinator', REPLY_SECOND)], false, '回复二')
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 600)))

  const recorded = await frames(page)
  // Order: every frame lists the messages in the order they were said.
  const said = [...history.map(entry => entry.text.slice(0, 24).trim()), FIRST, '回复一', SECOND, '回复二']
  for (const frame of recorded) {
    const ranks = frame.order.map(text => said.findIndex(entry => text.startsWith(entry.slice(0, 8))))
    expect(ranks, `messages out of order: ${frame.order.join(' | ')}`).toEqual([...ranks].sort((a, b) => a - b))
  }
  // No jumps: with the person at the end, scrollTop only moves down.
  const jumps = recorded.flatMap((frame, index) => index && frame.top < recorded[index - 1].top - 2 ? [`${frame.step}: ${recorded[index - 1].top}→${frame.top}`] : [])
  expect(jumps, 'scroll jumped back while replies arrived').toEqual([])
  // The last reply is fully on screen, above the composer.
  const reply = conversation(page).locator('[data-slot="message"]').last()
  await expect(reply).toContainText('回复二')
  const box = await reply.boundingBox()
  const area = await viewport(page).boundingBox()
  const composer = await page.getByRole('textbox', { name: '给 Coordinator 发消息', exact: true }).boundingBox()
  expect(box && area && composer).toBeTruthy()
  expect(box!.y + box!.height).toBeLessThanOrEqual(area!.y + area!.height + 1)
  expect(box!.y + box!.height).toBeLessThanOrEqual(composer!.y)
  await expect(page.locator('[data-slot="message-scroller-button"][data-active="true"]')).toHaveCount(0)

  // Scrolled up to read: a further reply leaves the person where they are.
  await viewport(page).hover()
  await page.mouse.wheel(0, -1500)
  await expect.poll(() => viewport(page).evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(1000)
  const reading = await viewport(page).evaluate(element => element.scrollTop)
  await serve(page, chat, [...chat.items, item(last + 5, 'coordinator', `回复三 ${'补充 '.repeat(30)}`)], false, '回复三')
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 600)))
  expect(Math.abs(await viewport(page).evaluate(element => element.scrollTop) - reading)).toBeLessThanOrEqual(2)
})
