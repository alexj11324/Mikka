import type { Page } from '@playwright/test'
import { test, expect, register } from './fixtures'

// The Agent source is driven by routing `/api/agent/sessions`. The Coordinator's state
// comes from the `getCoordinatorChat` server action; like progressive-loading.spec.ts we
// intercept `next-action` POSTs, fetch the real response and rewrite only the chat view's
// `enabled`/`working` flags. No production code or test flag is involved.
type Status = 'pending' | 'complete'
function history(status: Status | null) {
  return { sessions: [], sessionId: status ? '00000000-0000-4000-8000-000000000001' : null, turns: status ? [{ id: 't1', prompt: 'p', completion: '', status, error: null }] : [] }
}

async function mockSessions(page: Page, initial: Status | null) {
  const state = { status: initial }
  await page.route('**/api/agent/sessions?*', route => route.fulfill({ json: history(state.status) }))
  await page.route('**/api/agent/sessions', route => route.fulfill({ json: history(state.status) }))
  return state
}

const WORKING_FLAG = /"working"\s*:\s*(true|false)/
const COORDINATOR_CHAT_SHAPE = /"items"\s*:\s*\[/

/**
 * Rewrites only the `getCoordinatorChat` server action. Its id is resolved at runtime:
 * the first `Next-Action` POST that sends no arguments (`[]`) and answers with a chat
 * view (`items` + `working`) pins `actionId`; after that only that id is rewritten and
 * every other request (other actions, sendCoordinatorMessage with its text arg) passes through.
 */
async function mockCoordinatorWorking(page: Page, initial: boolean) {
  const state = { working: initial, rewrites: 0, actionId: null as string | null }
  await page.route('**/*', async route => {
    const request = route.request()
    const actionId = request.headers()['next-action']
    if (request.method() !== 'POST' || !actionId) return route.fallback()
    if (state.actionId && actionId !== state.actionId) return route.fallback()
    if (!state.actionId && (request.postData() ?? '').trim() !== '[]') return route.fallback()
    const response = await route.fetch()
    const body = await response.text()
    if (!state.actionId) {
      if (!(WORKING_FLAG.test(body) && COORDINATOR_CHAT_SHAPE.test(body))) return route.fulfill({ response, body })
      state.actionId = actionId
    }
    state.rewrites++
    const rewritten = body
      .replace(new RegExp(WORKING_FLAG.source, 'g'), `"working":${state.working}`)
      .replace(/"enabled"\s*:\s*(true|false)/g, '"enabled":true')
      .replace(/"error"\s*:\s*"(?:[^"\\]|\\.)*"/g, '"error":null')
    return route.fulfill({ response, body: rewritten })
  })
  return state
}

async function openCoordinator(page: Page) {
  await page.getByRole('button', { name: 'Coordinator', exact: true }).first().click()
  await expect(page.getByRole('region', { name: 'Coordinator' })).toBeVisible()
}

const bar = (page: Page) => page.locator('[data-working-status]')

test('谁正在工作：无人工作时整条隐藏', async ({ page }) => {
  await mockSessions(page, null)
  await register(page)
  await openCoordinator(page)
  await page.waitForTimeout(600)
  await expect(bar(page)).toHaveCount(0)
})

test('谁正在工作：切换过程中文字始终可读', async ({ page }) => {
  const state = await mockSessions(page, 'pending')
  await register(page)
  await openCoordinator(page)
  await expect(bar(page).locator('[data-working-text]').first()).toContainText('Agent 正在工作…')
  state.status = 'complete'
  for (let i = 0; i < 8; i++) {
    const texts = await bar(page).locator('[data-working-text]').allInnerTexts().catch(() => [])
    for (const text of texts) expect(text.trim().length).toBeGreaterThan(0)
    await page.waitForTimeout(40)
  }
})

test('谁正在工作：300ms 内的多次变化只显示最终状态', async ({ page }) => {
  const state = await mockSessions(page, null)
  await register(page)
  await openCoordinator(page)
  const seen: string[] = []
  await page.exposeFunction('reportWorking', (text: string) => { seen.push(text) })
  await page.evaluate(() => new MutationObserver(() => {
    const text = document.querySelector('[data-working-status] [data-working-text]')?.textContent
    if (text) (window as unknown as { reportWorking: (t: string) => void }).reportWorking(text)
  }).observe(document.body, { subtree: true, childList: true, characterData: true }))
  // Flip quickly within one 300ms window; only the last state should render.
  state.status = 'pending'
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  state.status = 'complete'
  state.status = 'pending'
  await expect(bar(page).locator('[data-working-text]').first()).toContainText('Agent 正在工作…', { timeout: 15_000 })
  expect(new Set(seen).size).toBeLessThanOrEqual(1)
})

test('谁正在工作：减弱动效时没有滚动和流光', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await mockSessions(page, 'pending')
  await register(page)
  await openCoordinator(page)
  await expect(bar(page)).toBeVisible()
  await expect(bar(page).locator('.beui-text-shimmer')).toHaveCount(0)
  await expect(bar(page).locator('[data-static-text]')).toHaveText('Agent 正在工作…')
  // The roll keeps an invisible sizer copy; the crossfade renders a single row.
  await expect(bar(page).locator('[data-working-text]')).toHaveCount(1)
})

test('谁正在工作：仅 Coordinator 工作时显示单人文案', async ({ page }) => {
  await mockSessions(page, null)
  const coordinator = await mockCoordinatorWorking(page, true)
  await register(page)
  await openCoordinator(page)
  await expect.poll(() => coordinator.rewrites, { message: 'Coordinator chat response was never rewritten; the mock did not match the flight payload' }).toBeGreaterThan(0)
  await expect(bar(page).locator('[data-working-text]').first()).toContainText('Coordinator 正在工作…')
})

test('谁正在工作：Coordinator 与 Agent 同时工作时显示双人文案', async ({ page }) => {
  await mockSessions(page, 'pending')
  const coordinator = await mockCoordinatorWorking(page, true)
  await register(page)
  await openCoordinator(page)
  await expect.poll(() => coordinator.rewrites, { message: 'Coordinator chat response was never rewritten; the mock did not match the flight payload' }).toBeGreaterThan(0)
  await expect(bar(page).locator('[data-working-text]').first()).toContainText('Coordinator 和 Agent 正在工作…')
  await expect(bar(page).locator('[data-slot="avatar"]')).toHaveCount(2)
})
