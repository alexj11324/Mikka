import { test, expect, register, conversationPill } from './fixtures'

// The first-run guide (docs/design/onboarding.md): a new account names its
// first Bot in one conversation, lands in that Bot's chat, and never sees the
// guide again. The workspace has no E2B key yet, so the Bot asks about the
// cloud computer; Composio is not configured in e2e, so the apps step is skipped.
test('新账号走完引导：起名、选外观，进入这个 Bot 的对话，之后不再出现', async ({ page }) => {
  await register(page, '/', undefined, { onboarding: true })
  const guide = page.getByRole('dialog', { name: '创建你的第一个 Bot', exact: true })
  await expect(guide).toBeVisible()

  await guide.getByRole('button', { name: '开始', exact: true }).click()
  await expect(guide.getByText('你好。先给我起个名字，选个外观。')).toBeVisible()
  await guide.getByPlaceholder('名字').fill('小满')
  await guide.getByRole('button', { name: '爱心', exact: true }).click()
  await guide.getByRole('button', { name: '绿色', exact: true }).click()
  await guide.getByRole('button', { name: '确定', exact: true }).click()
  await expect(guide.getByText('就叫小满')).toBeVisible()
  await expect(guide.getByText('好的，以后我叫小满。')).toBeVisible({ timeout: 15000 })
  await expect(guide.getByText('开通云电脑后，我可以浏览网页，线程也能在云端运行。现在开通吗？')).toBeVisible({ timeout: 15000 })
  await guide.getByRole('button', { name: '暂不开通', exact: true }).click()
  await expect(guide.getByText('以后可以在设置里开通云电脑。')).toBeVisible({ timeout: 15000 })

  await guide.getByRole('button', { name: '进入 Mikka', exact: true }).click({ timeout: 20000 })
  await expect(guide).toHaveCount(0)
  await expect(conversationPill(page)).toHaveText('小满')
  const row = page.getByRole('list', { name: 'Bot', exact: true }).getByRole('button', { name: '小满', exact: true })
  await expect(row.locator('[data-slot="bot-avatar"]')).toHaveAttribute('data-shape', 'coeur')
  await expect(row.locator('[data-slot="bot-avatar"]')).toHaveAttribute('data-color', 'vert')

  await page.reload()
  await expect(page.getByRole('list', { name: 'Bot', exact: true })).toBeVisible()
  await expect(guide).toHaveCount(0)
})

test('跳过引导后不再出现', async ({ page }) => {
  await register(page, '/', undefined, { onboarding: true })
  const guide = page.getByRole('dialog', { name: '创建你的第一个 Bot', exact: true })
  await guide.getByRole('button', { name: '跳过引导', exact: true }).click()
  await expect(guide).toHaveCount(0)
  await page.reload()
  const bots = page.getByRole('list', { name: 'Bot', exact: true })
  await expect(bots.getByRole('button', { name: 'Coordinator', exact: true })).toBeVisible()
  await expect(guide).toHaveCount(0)
})


// 绑定订阅 (decisions/2026-11-02-1645): with subscriptions on, the guide shows
// Settings › 模型订阅's rows under 绑定订阅 after the name, and the step can be
// skipped. e2e has no subscription backend, so the list is answered here.
test('引导里可以绑定订阅，也可以跳过', async ({ page }) => {
  await page.route(/\/api\/subscriptions\?workspace=/, route => route.fulfill({ json: { enabled: true, providers: [{ provider: 'codex', available: true }, { provider: 'claude', available: true }], connections: [] } }))
  await register(page, '/', undefined, { onboarding: true })
  const guide = page.getByRole('dialog', { name: '创建你的第一个 Bot', exact: true })
  await guide.getByRole('button', { name: '开始', exact: true }).click()
  await guide.getByPlaceholder('名字').fill('小满')
  await guide.getByRole('button', { name: '确定', exact: true }).click()
  await expect(guide.getByText('要绑定你的 Claude 或 ChatGPT 订阅吗？')).toBeVisible({ timeout: 15000 })
  await expect(guide.getByRole('heading', { name: '绑定订阅', exact: true })).toBeVisible()
  await expect(guide.getByRole('button', { name: '连接', exact: true })).toHaveCount(2)
  await guide.getByRole('button', { name: '暂不绑定', exact: true }).click()
  await expect(guide.getByText('好的。之后可以在设置中绑定。')).toBeVisible({ timeout: 15000 })
  await expect(guide.getByText('开通云电脑后，我可以浏览网页，线程也能在云端运行。现在开通吗？')).toBeVisible({ timeout: 15000 })
})
