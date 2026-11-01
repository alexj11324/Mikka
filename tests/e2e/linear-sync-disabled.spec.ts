import { test, expect } from './test-account-fixtures'
import { app } from './fixtures'

test('paused Linear settings do not poll state or start OAuth', async ({ page }) => {
  await page.clock.install()
  let availabilityReads = 0
  await page.route('**/api/integrations/linear/status', async route => {
    availabilityReads++
    await route.continue()
  })
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  await page.getByRole('link', { name: '连接', exact: true }).click()
  // The list reads availability once for Linear's state word.
  await expect(page.getByRole('link', { name: '打开 Linear', exact: true })).toBeVisible()
  await expect.poll(() => availabilityReads).toBe(1)
  await page.waitForLoadState('networkidle')
  await page.getByRole('link', { name: '打开 Linear', exact: true }).click()
  await expect(page).toHaveURL(url => url.searchParams.get('app') === 'linear')
  await expect(page.getByText('同步已暂停', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '连接 Linear', exact: true })).toBeDisabled()
  expect(availabilityReads).toBe(2)
  await page.waitForLoadState('networkidle')
  const stateActions: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && request.headers()['next-action']) stateActions.push(request.url())
  })
  // Two minutes of visible idle must produce no settings action or flag poll.
  await page.clock.runFor(120_000)
  expect(availabilityReads).toBe(2)
  expect(stateActions).toEqual([])
  const response = await page.request.get(app('/api/integrations/linear/status'))
  expect(await response.json()).toMatchObject({ enabled: false })
  // Focus and visibility read nothing (decision 2026-11-01-0400-no-refetch-on-focus).
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.clock.runFor(5_000)
  expect(availabilityReads).toBe(2)
  expect(stateActions).toEqual([])
  await expect(page.getByText('同步已暂停', { exact: true })).toBeVisible()
})
