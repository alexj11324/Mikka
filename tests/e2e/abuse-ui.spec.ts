import { test, expect, app, register, seedCoordinatorError, seedHostedVerification } from './fixtures'
import { attachLightDark } from './settings-v4-shots'

// 免费额度, 余额 and the Mikka 默认 notices (Figma BIL-*, ALW-*) on the #531 backend.
// #558 (Checkout card verification) and #559 (points purchase) are not on main,
// so the card row reads 暂不可用 and 充值 is unavailable; verification and the
// allowance are seeded in the database as Stripe's webhook would leave them.

test('计费：未验证时显示免费额度和余额；Checkout 未上线时显示暂不可用', async ({ page }, testInfo) => {
  await register(page, '/settings?section=billing')
  const allowance = page.getByRole('region', { name: '免费额度' })
  await expect(allowance.getByText('银行卡验证', { exact: true })).toBeVisible()
  await expect(allowance.getByText('不扣款；验证后可免费使用 1 美元的')).toBeVisible()
  await expect(allowance.getByRole('status')).toHaveText('暂不可用')
  await expect(page.locator('[data-slot="balance"]')).toHaveText('0 点')
  await attachLightDark(page, testInfo, 'billing-unverified')
  await page.getByRole('button', { name: '充值', exact: true }).click()
  await page.getByRole('menuitem', { name: /\$10\.00 · 1,000 点/ }).click()
  await expect(page.getByText('充值暂不可用')).toBeVisible()
})

test('计费：从 Checkout 返回且已验证时，免费额度消失，$1 计入余额', async ({ page }, testInfo) => {
  await register(page, '/settings?section=billing')
  await expect(page.getByRole('region', { name: '免费额度' })).toBeVisible()
  await seedHostedVerification(page, 1_000_000)
  await page.goto(app('/settings?section=billing&verify=success&session_id=cs_test_fixture'))
  await expect(page.getByText('银行卡已验证')).toBeVisible()
  await expect(page.getByRole('region', { name: '免费额度' })).toHaveCount(0)
  await expect(page.locator('[data-slot="balance"]')).toHaveText('100 点')
  await expect(page).not.toHaveURL(/verify=|session_id=/)
  await attachLightDark(page, testInfo, 'billing-verified')
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
