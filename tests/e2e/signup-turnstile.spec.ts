import { test, expect, app } from './fixtures'

// Sign-up refusals from #527 (docs/backend/hosted-abuse-controls.md). Better Auth's
// response is mocked; CI builds without NEXT_PUBLIC_TURNSTILE_SITE_KEY, so the
// widget renders nothing and no token header is sent.

// The browser logs each refused request; that line is expected, nothing else is.
const refusedLog = (path: string, status: number) => ({ path: app(path), message: `Failed to load resource: the server responded with a status of ${status} (${status === 429 ? 'Too Many Requests' : 'Bad Request'})` })

for (const { code, status, message } of [
  { code: 'DISPOSABLE_EMAIL', status: 400, message: '不支持临时邮箱，请使用常用邮箱。' },
  { code: 'EMAIL_ALREADY_REGISTERED', status: 400, message: '该邮箱已注册，请直接登录。' },
  { code: 'SIGNUP_RATE_LIMITED', status: 429, message: '注册请求过多，请稍后重试。' },
  { code: 'TURNSTILE_INVALID', status: 400, message: '人机验证未通过' },
  { code: 'TURNSTILE_REQUIRED', status: 400, message: '人机验证未通过' },
]) test.describe(code, () => {
  test.use({ expectedConsoleErrors: [refusedLog('/api/auth/sign-up/email', status)] })
  test(`注册被拒绝时显示原因：${code}`, async ({ page }, testInfo) => {
    let turnstileHeader: string | null | undefined
    await page.route('**/api/auth/sign-up/email', route => {
      turnstileHeader = route.request().headers()['x-turnstile-token'] ?? null
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ code, message: code }) })
    })
    await page.goto(app('/sign-up'))
    await page.getByLabel('称呼', { exact: true }).fill('回归测试成员')
    await page.getByLabel('邮箱', { exact: true }).fill('someone@example.com')
    await page.getByLabel('密码', { exact: true }).fill('correct-horse-battery')
    await page.getByRole('button', { name: '创建账号并进入', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible()
    if (!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) {
      expect(turnstileHeader).toBeNull()
      await expect(page.locator('[data-slot="turnstile"]')).toHaveCount(0)
    }
    await testInfo.attach(`signup-${code.toLowerCase()}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  })
})

test.describe('重新发送验证邮件', () => {
  test.use({ expectedConsoleErrors: [refusedLog('/api/auth/send-verification-email', 400)] })
  test('重新发送验证邮件时显示人机验证失败', async ({ page }) => {
    await page.route('**/api/auth/send-verification-email', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'TURNSTILE_REQUIRED' }) }))
    await page.goto(app('/verify-email'))
    await page.getByLabel('邮箱', { exact: true }).fill('someone@example.com')
    await page.getByRole('button', { name: '发送验证链接' }).click()
    await expect(page.getByRole('alert').filter({ hasText: '人机验证未通过' })).toBeVisible()
  })
})

test.describe('带站点密钥的构建', () => {
  // Turnstile's own script is replaced by a stand-in that issues a token, so the
  // header can be checked without Cloudflare. Skipped when the build has no key.
  test.skip(!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY, 'build has no NEXT_PUBLIC_TURNSTILE_SITE_KEY')
  test('注册请求带上 Turnstile 令牌', async ({ page }) => {
    await page.route('https://challenges.cloudflare.com/**', route => route.fulfill({ contentType: 'application/javascript', body: `window.turnstile = { render: function (el, o) { el.textContent = 'turnstile'; setTimeout(function () { o.callback('fixture-token') }, 0); return 'w1' }, reset: function () {}, remove: function () {} }` }))
    let header: string | undefined
    await page.route('**/api/auth/sign-up/email', route => { header = route.request().headers()['x-turnstile-token']; return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'DISPOSABLE_EMAIL' }) }) })
    await page.goto(app('/sign-up'))
    await expect(page.locator('[data-slot="turnstile"]')).toHaveText('turnstile')
    await page.getByLabel('称呼', { exact: true }).fill('回归测试成员')
    await page.getByLabel('邮箱', { exact: true }).fill('someone@example.com')
    await page.getByLabel('密码', { exact: true }).fill('correct-horse-battery')
    await page.getByRole('button', { name: '创建账号并进入', exact: true }).click()
    await expect.poll(() => header).toBe('fixture-token')
  })
})
