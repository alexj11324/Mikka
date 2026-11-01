import { test, expect, app, register, seedCoordinatorError, seedHostedVerification } from './fixtures'
import { attachLightDark } from './settings-v4-shots'

// No Stripe keys: real actions report unavailable and cannot contact Stripe.
// Verification and its allowance are seeded as the webhook would leave them.

test.beforeAll(() => {
  expect(process.env.STRIPE_SECRET_KEY, 'This spec requires Stripe to be unconfigured').toBeFalsy()
})

test('计费：Stripe 未配置时只显示状态，没有免费额度、余额和充值', async ({ page }, testInfo) => {
  await register(page, '/settings?section=billing')
  await expect(page.getByRole('status').filter({ hasText: '计费尚未开通。' })).toBeVisible()
  await expect(page.getByRole('region', { name: '免费额度' })).toHaveCount(0)
  await expect(page.locator('[data-slot="balance"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '充值', exact: true })).toHaveCount(0)
  await attachLightDark(page, testInfo, 'billing-unverified')
})

test('计费：Stripe 未配置时已赠送的 $1 仍显示在余额，但不能充值', async ({ page }, testInfo) => {
  await register(page, '/settings?section=billing')
  await expect(page.getByRole('status').filter({ hasText: '计费尚未开通。' })).toBeVisible()
  await seedHostedVerification(page, 1_000_000)
  await page.reload()
  await expect(page.locator('[data-slot="balance"]')).toHaveText('100 点')
  await expect(page.getByRole('button', { name: '充值', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '免费额度' })).toHaveCount(0)
  await attachLightDark(page, testInfo, 'billing-return-unavailable')
})

test('用量：显示余额', async ({ page }, testInfo) => {
  await register(page, '/settings?section=usage')
  await expect(page.locator('[data-slot="balance"]')).toContainText('0 点')
  await seedHostedVerification(page, 734_000)
  await page.reload()
  await expect(page.locator('[data-slot="balance"]')).toContainText('73 点')
  await expect(page.locator('[data-slot="balance"]')).toContainText('余额')
  await attachLightDark(page, testInfo, 'usage-balance')
})

for (const { code, title, card } of [
  { code: 'verification_required', title: '使用 Mikka 默认模型前需要验证银行卡', card: true },
  { code: 'free_allowance_used', title: '免费额度已用完', card: true },
  { code: 'points_exhausted', title: '点数已用完', card: true },
  { code: 'platform_paused', title: '免费额度暂时停用', card: false },
]) {
  test(`对话：Mikka 默认被拒绝时显示 ${code}`, async ({ page }, testInfo) => {
    await register(page)
    await seedCoordinatorError(page, `PaidResourceError: ${code}`)
    await page.reload()
    const notice = page.locator(`[data-hosted-refusal="${code}"]`)
    await expect(notice).toContainText(title)
    await expect(page.getByText('回复失败', { exact: true })).toHaveCount(0)
    await expect(notice.getByRole('link', { name: '验证银行卡', exact: true })).toHaveCount(card ? 1 : 0)
    await expect(page.getByRole('textbox', { name: '给 Coordinator 发消息', exact: true })).toBeVisible()
    await attachLightDark(page, testInfo, `chat-${code}`)
    await notice.getByRole('link', { name: '连接 Claude / ChatGPT 订阅' }).click()
    await expect(page).toHaveURL(/section=models/)
  })
}

test('对话：已验证的工作区额度用完时不再提供验证银行卡', async ({ page }) => {
  await register(page, '/settings?section=usage')
  await expect(page.locator('[data-slot="balance"]')).toBeVisible()
  await seedHostedVerification(page, 0)
  await seedCoordinatorError(page, 'PaidResourceError: free_allowance_used')
  await page.goto(app('/'))
  const notice = page.locator('[data-hosted-refusal="free_allowance_used"]')
  await expect(notice).toContainText('免费额度已用完')
  await expect(notice.getByRole('link', { name: '连接 Claude / ChatGPT 订阅' })).toBeVisible()
  await expect(notice.getByRole('link', { name: '验证银行卡', exact: true })).toHaveCount(0)
})
