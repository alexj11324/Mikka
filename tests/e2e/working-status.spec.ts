import type { Page } from '@playwright/test'
import { test, expect, register } from './fixtures'

// The Coordinator's own state comes from a server action, so these tests drive the bar
// through the Agent source only (`/api/agent/sessions`).
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
