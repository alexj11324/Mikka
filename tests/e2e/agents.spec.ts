import { randomUUID } from 'node:crypto'
import { test, expect, register } from './fixtures'

test('默认三个角色、编辑放置、新建并删除自定义角色', async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Agent 角色', exact: true })
  await expect(panel.getByRole('heading', { name: 'Agent 角色', exact: true })).toBeVisible()
  for (const name of ['Coordinator', 'Worker', 'Reviewer']) {
    await expect(panel.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible()
  }
  await expect(panel.getByRole('region', { name: '编辑 Coordinator', exact: true })).toBeVisible()

  await panel.getByRole('button', { name: /^Reviewer/ }).click()
  const edit = panel.getByRole('region', { name: '编辑 Reviewer', exact: true })
  await expect(edit.getByLabel('系统提示词', { exact: true })).toHaveValue(/# Role: Reviewer/)
  await expect(edit.getByRole('button', { name: '删除', exact: true })).toHaveCount(0)
  await edit.getByLabel('模型', { exact: true }).click()
  await page.getByRole('option', { name: 'opus', exact: true }).click()
  await edit.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: /^Reviewer/ })).toContainText('opus')

  const name = `Tester ${randomUUID().slice(0, 8)}`
  await panel.getByRole('button', { name: '新建角色', exact: true }).click()
  const create = panel.getByRole('region', { name: '新建自定义角色', exact: true })
  await create.getByLabel('名称', { exact: true }).fill(name)
  await create.getByLabel('系统提示词', { exact: true }).fill('Write and run the tests that prove the change.')
  await create.getByRole('button', { name: '创建', exact: true }).click()
  await expect(panel.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible()

  await page.reload()
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  await panel.getByRole('button', { name: new RegExp(`^${name}`) }).click()
  await panel.getByRole('region', { name: `编辑 ${name}`, exact: true }).getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click()
  await expect(panel.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveCount(0)
})
