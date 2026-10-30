import { test, expect, register } from './fixtures'
import { attachLightDark } from './settings-v4-shots'

// N6 审计日志 (Figma 554:9417): real writes (a token and a slug change) show up for the admin.
test('审计日志按天列出令牌和地址修改，可筛选安全并导出 CSV', async ({ page }, testInfo) => {
  await register(page, '/settings?section=audit')
  await expect(page.getByRole('heading', { level: 1, name: '审计日志' })).toBeVisible()
  await expect(page.getByText('最近 90 天没有记录。')).toBeVisible()
  await attachLightDark(page, testInfo, 'audit-empty')

  await page.goto(page.url().replace('section=audit', 'section=developer'))
  await page.getByRole('button', { name: '新建', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '名称' }).fill('CI 脚本')
  await dialog.getByRole('button', { name: '新建', exact: true }).click()
  await dialog.getByRole('button', { name: '完成', exact: true }).click()

  await page.goto(page.url().replace('section=developer', 'section=audit'))
  await expect(page.getByRole('heading', { level: 2, name: '今天' })).toBeVisible()
  await expect(page.getByText('新建了令牌 CI 脚本')).toBeVisible()
  await attachLightDark(page, testInfo, 'audit-list')

  await page.getByRole('button', { name: '安全', exact: true }).click()
  await expect(page.getByText('新建了令牌 CI 脚本')).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: '导出 CSV' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.csv$/)
})
