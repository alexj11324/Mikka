import { test, expect, register, app } from './fixtures'

// Review C3: Better Auth allows 5 code lookups per address per 30 minutes. The 6th answers 429, which the page
// read as 「验证码无效或已过期」, so 重新输入 sent people in circles. It now says what happened and when to try again.
test.use({ expectedConsoleErrors: [{ path: '/mikka/api/auth/device?user_code=ABCD-EFGH', message: 'Failed to load resource: the server responded with a status of 429 (Too Many Requests)' }] })

test('a rate-limited code lookup says so and when to try again', async ({ page }, testInfo) => {
  await register(page)
  // Better Auth's own limiter answers this; the fixture stands in for its 6th lookup in 30 minutes.
  await page.route('**/api/auth/device?user_code=*', route => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ message: 'Too many requests. Please try again later.' }) }))
  await page.goto(app('/device?user_code=ABCD-EFGH'))
  const card = page.getByRole('region', { name: '连接这台电脑', exact: true })
  await expect(card.getByText('查询次数过多，30 分钟后再试', { exact: true })).toBeVisible()
  await expect(card.getByText('验证码无效或已过期', { exact: true })).toHaveCount(0)
  await expect(card.getByRole('button', { name: '重新输入', exact: true })).toHaveCount(0)
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await testInfo.attach(`device-rate-limited-${scheme}`, { body: await page.screenshot(), contentType: 'image/png' })
  }
})
