import { test, expect, register, openSearch } from './fixtures'
import { seedLegacyHistory } from './legacy-chat-fixture'

// Preserve the existing budget; the retired composer no longer defines readiness.
const budget = process.env.CI ? 1200 : 1000

test('已保存历史只读正文在原有预算内就绪 @performance', async ({ page }, info) => {
  const { email } = await register(page)
  const saved = await seedLegacyHistory(email)
  await page.reload()
  await page.waitForLoadState('networkidle')
  const search = await openSearch(page)
  const entry = search.getByRole('option').filter({ hasText: `历史：${saved.title}` })
  await expect(entry).toBeVisible()
  const start = await page.evaluate(() => performance.now())
  await entry.click()
  const archive = page.getByTestId('legacy-chat-archive')
  await expect(archive.getByText('已保存的公开测试历史正文', { exact: true })).toBeVisible()
  await expect(archive.locator('textarea, form')).toHaveCount(0)
  const elapsed = await page.evaluate(async started => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    return performance.now() - started
  }, start)
  await info.attach('read-only-history-ready', { body: JSON.stringify({ elapsed, budget }), contentType: 'application/json' })
  expect(elapsed).toBeLessThan(budget)
})
