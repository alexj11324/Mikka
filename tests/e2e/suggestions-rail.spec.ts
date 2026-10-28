import { randomUUID } from 'node:crypto'
import { test, expect, register, rail, seedSuggestion } from './fixtures'

test('建议：点卡片把同一张卡和完整指令发进 Coordinator 对话，卡片离开列表；Artifact 页可打开', async ({ page }) => {
  await register(page)
  const subject = `周四的会 ${randomUUID().slice(0, 8)}`
  await seedSuggestion(page, { title: `Re: ${subject}`, actionTitle: `回复 Kevin 的 Gmail 邮件：${subject}` })
  await rail(page, '建议').click()
  await expect(page.getByRole('heading', { name: '建议', exact: true })).toBeVisible()
  const card = page.locator('button[data-slot="suggestion-card"]').filter({ hasText: subject })
  await expect(card).toContainText('回复')
  await card.click()
  const chat = page.getByRole('region', { name: 'Coordinator', exact: true })
  const sent = chat.locator('[data-slot="suggestion-card"]').filter({ hasText: subject })
  await expect(sent).toBeVisible()
  await expect(sent.locator('[data-slot="source-mention"]')).toHaveText('Gmail')
  await expect(chat.getByText('来源：Gmail')).toBeVisible()
  await expect(card).toHaveCount(0)

  await rail(page, 'Artifact').click()
  await expect(page.getByRole('heading', { name: 'Artifact', exact: true })).toBeVisible()
  await expect(page.getByText('还没有 Artifact', { exact: true })).toBeVisible()
  await expect(rail(page, 'Artifact')).toHaveAttribute('aria-current', 'page')
})
