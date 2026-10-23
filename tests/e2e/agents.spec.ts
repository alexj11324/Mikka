import { randomUUID } from 'node:crypto'
import pg from 'pg'
import type { Page } from '@playwright/test'
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

async function seedDevice(email: string) {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL })
  await client.connect()
  const harnesses = [{ harness: 'claude_code', installed: true, version: '2.0', models: [{ value: 'opus', displayName: 'Opus', efforts: ['low', 'medium', 'high'] }], permissionModes: ['plan'] }]
  await client.query(`insert into devices (id, "ownerId", name, harnesses, "lastSeenAt") select $1, id, 'Studio Mac', $2, now() from "user" where email = $3`, [randomUUID(), JSON.stringify(harnesses), email])
  await client.end()
}

async function openRuntime(page: Page) {
  await page.goto(app('/?settings=agents'))
  await page.getByRole('button', { name: /^Worker/ }).click()
  await page.getByRole('tab', { name: '运行环境' }).click()
}

async function pickModel(page: Page) {
  for (const [name, option] of [['机器', /Studio Mac/], ['Harness', /Claude/], ['模型', 'Opus']] as const) {
    await page.getByRole('combobox', { name }).click()
    await page.getByRole('option', { name: option }).click()
  }
}

test('Effort：宽屏为「默认」+ 模型档位的切换组，选择后自动保存', async ({ page }) => {
  const { email } = await register(page)
  await seedDevice(email)
  await openRuntime(page)
  await pickModel(page)
  const effort = page.getByRole('group', { name: 'Effort' })
  await expect(effort.getByRole('button')).toHaveText(['默认', 'Low', 'Medium', 'High'])
  await expect(effort.getByRole('button', { name: '默认' })).toHaveAttribute('aria-pressed', 'true')
  await effort.getByRole('button', { name: 'High' }).click()
  await expect(effort.getByRole('button', { name: 'High' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('combobox', { name: 'Effort' })).toBeHidden()
  await page.waitForLoadState('networkidle')
  await openRuntime(page)
  await expect(page.getByRole('group', { name: 'Effort' }).getByRole('button', { name: 'High' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('group', { name: 'Effort' }).getByRole('button', { name: '默认' }).click()
  await expect(page.getByRole('group', { name: 'Effort' }).getByRole('button', { name: '默认' })).toHaveAttribute('aria-pressed', 'true')
})

test('Effort：窄屏改用下拉选择', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { email } = await register(page)
  await seedDevice(email)
  await openRuntime(page)
  await pickModel(page)
  await expect(page.getByRole('group', { name: 'Effort' })).toBeHidden()
  const select = page.getByRole('combobox', { name: 'Effort' })
  await expect(select).toContainText('默认')
  await select.click()
  await expect(page.getByRole('option')).toHaveText(['默认', 'Low', 'Medium', 'High'])
  await page.getByRole('option', { name: 'Medium' }).click()
  await expect(select).toContainText('Medium')
})
