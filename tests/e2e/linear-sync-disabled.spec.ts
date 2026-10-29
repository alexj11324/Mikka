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
  await page.getByRole('link', { name: '集成', exact: true }).click()
  const section = page.getByRole('region', { name: 'Linear', exact: true })
  await expect(section.getByText('同步已暂停', { exact: true })).toBeVisible()
  await expect(section.getByRole('button', { name: '连接 Linear', exact: true })).toBeDisabled()
  expect(availabilityReads).toBe(1)
  // The issue-prefix settings action is unrelated; wait for it before counting idle actions.
  await expect(page.locator('#issue-prefix')).toBeEnabled()
  const stateActions: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && request.headers()['next-action']) stateActions.push(request.url())
  })
  // Two minutes of visible idle must produce no settings action or flag poll.
  await page.clock.runFor(120_000)
  expect(availabilityReads).toBe(1)
  expect(stateActions).toEqual([])
  const response = await page.request.get(app('/api/integrations/linear/status'))
  expect(await response.json()).toMatchObject({ enabled: false })
  // Focus checks availability again; other settings may revalidate on focus.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => availabilityReads).toBe(2)
  await expect(section.getByText('同步已暂停', { exact: true })).toBeVisible()
})
