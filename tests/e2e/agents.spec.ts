import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { test, expect, register, app } from './fixtures'

async function openAgentSettings(page: Page) {
  const mainUrl = page.url()
  await expect(page.getByRole('button', { name: 'Agent', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Agent 管理', exact: true })).toHaveCount(0)
  for (const label of ['成员管理', '邀请成员', '设备']) {
    await expect(page.getByRole('link', { name: label, exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0)
  }
  await page.getByRole('button', { name: '账户菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  for (const label of ['成员管理', '邀请成员']) {
    await expect(page.getByRole('link', { name: label, exact: true })).toBeVisible()
  }
  await page.getByRole('button', { name: '设备', exact: true }).click()
  await expect(page.getByRole('heading', { name: '设备', exact: true })).toBeVisible()
  await expect(page).toHaveURL(mainUrl)
  await page.getByRole('button', { name: 'Agent 管理', exact: true }).click()
}

test('设置中的Agent角色、运行环境、新建与删除', async ({ page }) => {
  await register(page)
  await page.goto(app('/devices'))
  await expect(page).toHaveURL(url => url.searchParams.get('settings') === 'devices')
  await expect(page.getByRole('heading', { name: '设备', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '返回应用', exact: true }).click()
  await expect(page).not.toHaveURL(/settings=devices/)
  await openAgentSettings(page)
  const panel = page.getByRole('region', { name: 'Agent 角色', exact: true })
  await expect(page.getByRole('heading', { name: 'Agent 管理', exact: true })).toBeVisible()
  await expect(panel).toBeVisible()
  const roleSelector = panel.getByRole('combobox', { name: '选择角色', exact: true })
  await expect(roleSelector).toHaveText('Coordinator')
  await roleSelector.click()
  for (const name of ['Coordinator', 'Worker', 'Reviewer']) {
    await expect(page.getByRole('option', { name, exact: true })).toBeVisible()
  }
  await page.getByRole('option', { name: 'Reviewer', exact: true }).click()
  const edit = panel.getByRole('region', { name: '编辑 Reviewer', exact: true })
  await expect(edit.getByLabel('系统提示词', { exact: true })).toHaveValue(/# Role: Reviewer/)
  await expect(edit.getByRole('button', { name: '删除', exact: true })).toHaveCount(0)
  await edit.getByLabel('模型', { exact: true }).click()
  await page.getByRole('option', { name: 'opus', exact: true }).click()
  await edit.getByRole('button', { name: '保存', exact: true }).click()
  await expect(edit.getByLabel('模型', { exact: true })).toHaveText('opus')

  const name = `Tester ${randomUUID().slice(0, 8)}`
  await panel.getByRole('button', { name: '新建角色', exact: true }).click()
  const create = panel.getByRole('region', { name: '新建自定义角色', exact: true })
  await create.getByLabel('名称', { exact: true }).fill(name)
  await create.getByLabel('系统提示词', { exact: true }).fill('Write and run the tests that prove the change.')
  await create.getByRole('button', { name: '创建', exact: true }).click()
  await expect(roleSelector).toHaveText(name)

  await page.reload()
  await openAgentSettings(page)
  await roleSelector.click()
  await page.getByRole('option', { name, exact: true }).click()
  await panel.getByRole('region', { name: `编辑 ${name}`, exact: true }).getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click()
  await roleSelector.click()
  await expect(page.getByRole('option', { name, exact: true })).toHaveCount(0)
})
