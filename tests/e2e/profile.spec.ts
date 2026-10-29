import { test, expect, register } from './fixtures'

/**
 * D12: the display name was a read-only span. It is an input that saves in
 * place and survives a reload.
 */
test('个人资料名称可以编辑，保存后刷新仍然生效', async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  const sidebar = page.locator('[data-slot="sidebar-container"]')
  await sidebar.getByRole('link', { name: '个人资料', exact: true }).click()

  const name = page.getByRole('textbox', { name: '名称', exact: true })
  await expect(name).toHaveValue('回归测试成员')
  await name.fill('新的显示名')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('已保存', { exact: true })).toBeVisible()

  await page.reload()
  await page.locator('[data-slot="sidebar-container"]').getByRole('link', { name: '个人资料', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('新的显示名')
})

// D14: the language row was a span. Choosing English switches the interface.
test('切换界面语言后进入英文界面', async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  await page.getByRole('group', { name: '界面语言', exact: true }).getByRole('button', { name: 'English', exact: true }).click()
  await expect(page).toHaveURL(/\/en\//)
  await expect(page.getByRole('heading', { name: 'Preferences', exact: true })).toBeVisible()
})
