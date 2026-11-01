import type { Page } from '@playwright/test'
import { test, expect, register } from './fixtures'

// 停止 while the Coordinator answers: send turns into stop (same place, a
// square), Esc does the same, and the stopped reply keeps its words under 已停止.
// The chat's state comes from `getCoordinatorChat` rewritten the way
// coordinator-scroll.spec.ts does; the stop itself is the real server action.
// The workflow side of a stop (abort, words kept, marked) is
// lib/agent-kit/core-entry.test.ts and lib/coordinator/stop.test.ts.
type Item = { id?: string; position: number; from: 'person' | 'coordinator'; text: string; tools: string[]; threads: string[]; artifacts: string[]; createdAt: string; stopped?: true }
const item = (position: number, from: Item['from'], text: string, stopped = false): Item => ({ id: `m-${position}`, position, from, text, tools: [], threads: [], artifacts: [], createdAt: '2026-11-01T00:00:00.000Z', ...(stopped ? { stopped: true as const } : {}) })
const ASKED = item(1, 'person', '写一份发布清单')
const PARTIAL = '发布清单：一、冻结 main'

const ITEMS = /"items"\s*:\s*\[[^\]]*\]/

async function mockChat(page: Page) {
  const state = { items: [ASKED] as Item[], working: true, stops: 0, chatAction: null as string | null }
  await page.route('**/*', async route => {
    const request = route.request()
    const actionId = request.headers()['next-action']
    if (request.method() !== 'POST' || !actionId) return route.fallback()
    if (state.chatAction && actionId !== state.chatAction) {
      const response = await route.fetch()
      const body = await response.text()
      // The stop action answers `{ stopped }`; once it has, the turn is over.
      if (/"stopped"\s*:\s*(true|false)/.test(body)) {
        state.stops++
        state.working = false
        state.items = [ASKED, item(2, 'coordinator', PARTIAL, true)]
      }
      return route.fulfill({ response, body })
    }
    if (!state.chatAction && (request.postData() ?? '').trim() !== '[]') return route.fallback()
    const response = await route.fetch()
    const body = await response.text()
    if (!ITEMS.test(body) || !/"working"\s*:/.test(body)) return route.fulfill({ response, body })
    state.chatAction = actionId
    return route.fulfill({ response, body: body.replace(ITEMS, `"items":${JSON.stringify(state.items)}`).replace(/"working"\s*:\s*(true|false)/, `"working":${state.working}`).replace(/"enabled"\s*:\s*false/, '"enabled":true') })
  })
  await page.context().route('**/api/conversations/coordinator/read', route => route.fulfill({ json: { lastReadMessageId: null, lastReadPosition: null, unreadCount: 0 } }))
  return state
}

const conversation = (page: Page) => page.getByRole('region', { name: '与 Coordinator 的对话', exact: true })
const composer = (page: Page) => page.getByRole('textbox', { name: '给 Coordinator 发消息', exact: true })

async function openWorkingChat(page: Page) {
  const chat = await mockChat(page)
  await register(page)
  await page.getByRole('button', { name: 'Coordinator', exact: true }).first().click()
  await expect(conversation(page).getByText('Coordinator 正在处理…')).toBeVisible()
  return chat
}

test('while the Coordinator answers, send is stop; stopping keeps what it said, marked 已停止', async ({ page }) => {
  const chat = await openWorkingChat(page)
  const stop = page.getByRole('button', { name: '停止', exact: true })
  await expect(stop).toBeVisible()
  await expect(page.getByRole('button', { name: '发送', exact: true })).toHaveCount(0)
  // A message typed meanwhile still goes: the button is send again until the field is empty.
  await composer(page).fill('再加一项')
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
  await expect(stop).toHaveCount(0)
  await composer(page).fill('')
  await stop.click()
  await expect.poll(() => chat.stops).toBe(1)
  await expect(conversation(page).getByText(PARTIAL)).toBeVisible()
  await expect(conversation(page).getByRole('status').filter({ hasText: '已停止' })).toBeVisible()
  await expect(conversation(page).getByText('Coordinator 正在处理…')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
})

test('Esc in the composer stops the reply as the stop button does', async ({ page }) => {
  const chat = await openWorkingChat(page)
  await composer(page).focus()
  await page.keyboard.press('Escape')
  await expect.poll(() => chat.stops).toBe(1)
  await expect(conversation(page).getByRole('status').filter({ hasText: '已停止' })).toBeVisible()
})
