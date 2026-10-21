import { randomUUID } from 'node:crypto'
import { test, expect, register } from './fixtures'

test('默认三个角色、编辑放置、新建并删除自定义角色', async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Agent 角色', exact: true })
  await expect(panel.getByRole('heading', { name: 'Agent 角色', exact: true })).toBeVisible()
  for (const name of ['Coordinator', 'Worker', 'Reviewer']) {
    await expect(panel.getByText(name, { exact: true })).toBeVisible()
  }
  await expect(panel.getByRole('button', { name: '删除 Worker', exact: true })).toHaveCount(0)

  await panel.getByRole('button', { name: '编辑 Reviewer', exact: true }).click()
  const edit = page.getByRole('dialog', { name: '编辑 Reviewer', exact: true })
  await expect(edit.getByLabel('系统提示词', { exact: true })).toHaveValue(/# Role: Reviewer/)
  await edit.getByLabel('模型', { exact: true }).click()
  await page.getByRole('option', { name: 'opus', exact: true }).click()
  await edit.getByRole('button', { name: '保存', exact: true }).click()
  await expect(edit).not.toBeVisible()
  await expect(panel.getByText('opus', { exact: true })).toBeVisible()

  const name = `Tester ${randomUUID().slice(0, 8)}`
  await panel.getByRole('button', { name: '新建角色', exact: true }).click()
  const create = page.getByRole('dialog', { name: '新建自定义角色', exact: true })
  await create.getByLabel('名称', { exact: true }).fill(name)
  await create.getByLabel('系统提示词', { exact: true }).fill('Write and run the tests that prove the change.')
  await create.getByRole('button', { name: '创建', exact: true }).click()
  await expect(create).not.toBeVisible()
  await expect(panel.getByText(name, { exact: true })).toBeVisible()

  await page.reload()
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  await panel.getByRole('button', { name: `删除 ${name}`, exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click()
  await expect(panel.getByText(name, { exact: true })).toHaveCount(0)
})
