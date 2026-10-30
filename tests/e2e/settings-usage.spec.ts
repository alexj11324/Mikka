import { test, expect, register } from './fixtures'
import { attachLightDark } from './settings-v4-shots'

// V14 用量 (Figma 551:8473) for the admin of a fresh workspace: month picker, grouping, chart, empty table.
test('用量按月显示线程和运行时长，可以按成员分组', async ({ page }, testInfo) => {
  await register(page, '/settings?section=usage')
  await expect(page.getByRole('heading', { level: 1, name: '用量' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: '月份' })).toBeVisible()
  await expect(page.getByText('这个月没有线程。')).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Bot' })).toBeVisible()
  await attachLightDark(page, testInfo, 'usage-admin')
  await page.getByRole('button', { name: '按成员', exact: true }).click()
  await expect(page.getByRole('columnheader', { name: '成员' })).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 CSV' }).click()
  expect((await download).suggestedFilename()).toMatch(/^usage-\d{4}-\d{2}-members\.csv$/)
  await attachLightDark(page, testInfo, 'usage-by-member')
})
