import { test, expect, register } from './fixtures'
import { attachLightDark } from './settings-v4-shots'

// V15 计费 (Figma 551:10912). CI has no Stripe key, so the page states that billing is not set up;
// Checkout, the Customer Portal and the webhook are covered with a fake Stripe in tests/billing.db.test.ts.
test('计费在未配置 Stripe 时只显示状态，不渲染卡片或税务表单', async ({ page }, testInfo) => {
  await register(page, '/settings?section=billing')
  await expect(page.getByRole('heading', { level: 1, name: '计费' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: '计费尚未开通。' })).toBeVisible()
  await expect(page.getByRole('textbox')).toHaveCount(1) // the sidebar search only
  await attachLightDark(page, testInfo, 'billing-not-configured')
})
