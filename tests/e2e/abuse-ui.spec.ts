import { test, expect, app, register, seedCoordinatorError, seedHostedVerification } from './fixtures'
import { attachLightDark } from './settings-v4-shots'

// Card verification and Mikka 默认 states (#523, #525, #526) on the #531 backend.
// CI has no Stripe keys, so 验证银行卡 opens to 暂不可用; verification and the
// allowance are seeded in the database as Stripe's webhook would leave them.

test('计费：未验证时显示验证银行卡；Stripe 未配置时对话框显示暂不可用', async ({ page }, testInfo) => {
  await register(page, '/settings?section=billing')
  await expect(page.getByText('一次性 $1 额度', { exact: true })).toBeVisible()
  await attachLightDark(page, testInfo, 'billing-verify-required')
  await page.getByRole('button', { name: '验证银行卡', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '验证银行卡' })
  await expect(dialog.getByRole('status').filter({ hasText: '暂不可用' })).toBeVisible()
  await expect(dialog.getByText('Secured by Stripe')).toBeVisible()
  await attachLightDark(page, testInfo, 'billing-verify-unavailable')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click() // the dialog's ✕
  await expect(dialog).toHaveCount(0)
})

test('计费：已验证的工作区只显示状态', async ({ page }, testInfo) => {
  await register(page)
  await seedHostedVerification(page, 1_000_000)
  await page.goto(app('/settings?section=billing'))
  await expect(page.getByText('已验证', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '验证银行卡', exact: true })).toHaveCount(0)
  await attachLightDark(page, testInfo, 'billing-verified')
})

test('用量：显示 Mikka 默认剩余额度', async ({ page }, testInfo) => {
  await register(page)
  await seedHostedVerification(page, 734_000)
  await page.goto(app('/settings?section=usage'))
  const remaining = page.locator('[data-slot="hosted-remaining"]')
  await expect(remaining).toContainText('US$0.73')
  await expect(remaining).toContainText('Mikka 默认剩余额度')
  await attachLightDark(page, testInfo, 'usage-hosted-remaining')
})

test('用量：未验证时显示未验证', async ({ page }) => {
  await register(page, '/settings?section=usage')
  await expect(page.locator('[data-slot="hosted-remaining"]')).toContainText('未验证')
})

for (const { code, title, action } of [
  { code: 'verification_required', title: 'Mikka 默认需要验证银行卡', action: '验证银行卡' },
  { code: 'free_allowance_used', title: 'Mikka 默认的 $1 额度已用完', action: '更换模型' },
  { code: 'points_exhausted', title: 'Mikka 默认的点数已用完', action: '更换模型' },
  { code: 'platform_paused', title: 'Mikka 默认已暂停，请稍后重试。', action: '更换模型' },
]) {
  test(`对话：Mikka 默认被拒绝时显示 ${code}`, async ({ page }, testInfo) => {
    await register(page)
    await seedCoordinatorError(page, `PaidResourceError: ${code}`)
    await page.reload()
    const notice = page.locator(`[data-hosted-refusal="${code}"]`)
    await expect(notice).toContainText(title)
    await expect(page.getByText('回复失败', { exact: true })).toHaveCount(0)
    const button = notice.getByRole(code === 'verification_required' ? 'button' : 'link', { name: action, exact: true })
    await expect(button).toBeVisible()
    await expect(page.getByRole('textbox', { name: '给 Coordinator 发消息', exact: true })).toBeVisible()
    await attachLightDark(page, testInfo, `chat-${code}`)
    if (code === 'verification_required') {
      await button.click()
      await expect(page.getByRole('dialog', { name: '验证银行卡' }).getByRole('status').filter({ hasText: '暂不可用' })).toBeVisible()
    } else {
      await button.click()
      await expect(page).toHaveURL(/section=models/)
    }
  })
}
