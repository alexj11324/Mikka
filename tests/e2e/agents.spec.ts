import { app, expect, register, test } from './fixtures'

test('Agent 设置：默认角色、详情两个标签、从预置创建并删除自定义角色', async ({ page }) => {
  await register(page)
  await page.goto(app('/?settings=agents'))
  await expect(page.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible()
  for (const name of ['Coordinator', 'Worker', 'Reviewer']) await expect(page.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible()

  await page.getByRole('button', { name: /^Worker/ }).click()
  await expect(page.getByRole('heading', { name: 'Role: Worker' })).toBeVisible()
  await page.getByRole('tab', { name: '编辑' }).click()
  await expect(page.getByRole('textbox', { name: '系统提示词' })).toHaveValue(/# Role: Worker/)
  await page.getByRole('tab', { name: '运行环境' }).click()
  await expect(page.getByRole('combobox', { name: '机器' })).toBeVisible()
  await expect(page.getByText('选好机器和 Harness 后显示可选档位')).toBeVisible()
  await page.getByRole('main').getByRole('button', { name: 'Agent', exact: true }).click()

  await page.getByRole('button', { name: '新建 Agent' }).click()
  await page.getByText('安全审查', { exact: true }).click()
  await expect(page.getByLabel('名称')).toHaveValue('安全审查')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.getByLabel('名称')).toHaveValue('安全审查')
  await expect(page.getByRole('heading', { name: 'Role: Security Reviewer' })).toBeVisible()

  await page.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('menuitem', { name: '删除' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '删除' }).click()
  await expect(page.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^安全审查/ })).toHaveCount(0)
})
