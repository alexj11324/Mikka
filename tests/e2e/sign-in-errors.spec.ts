import { randomBytes, randomUUID } from 'node:crypto'
import { test, expect, register, app, fillSecretPassword } from './fixtures'

// Usability review N4: a wrong password says 「邮箱或密码不正确」, an unknown email says exactly the same
// (no hint whether the account exists), and neither offers 验证邮箱, which is only for an unverified email.
test.use({ expectedConsoleErrors: [{ path: app('/api/auth/sign-in/email'), message: 'Failed to load resource: the server responded with a status of 401 (Unauthorized)' }] })

test('a failed email sign-in names the problem without saying whether the account exists', async ({ browser, page }, testInfo) => {
  const { email } = await register(page)
  const context = await browser.newContext({ locale: 'zh-CN' })
  const signIn = await context.newPage()
  try {
    for (const [label, address] of [['wrong-password', email], ['unknown-email', `e2e-${randomUUID()}@example.com`]] as const) {
      await signIn.goto(app('/sign-in'))
      await signIn.getByLabel('邮箱', { exact: true }).fill(address)
      await fillSecretPassword(signIn, randomBytes(24).toString('base64url'))
      await signIn.getByRole('button', { name: '登录工作台', exact: true }).click()
      await expect(signIn.getByRole('alert')).toHaveText('邮箱或密码不正确')
      await expect(signIn.getByRole('link', { name: '验证邮箱或重新发送验证邮件', exact: true })).toHaveCount(0)
      for (const scheme of ['light', 'dark'] as const) {
        await signIn.emulateMedia({ colorScheme: scheme })
        await testInfo.attach(`sign-in-${label}-${scheme}`, { body: await signIn.screenshot(), contentType: 'image/png' })
      }
      await signIn.emulateMedia({ colorScheme: 'light' })
    }
  } finally { await context.close() }
})
