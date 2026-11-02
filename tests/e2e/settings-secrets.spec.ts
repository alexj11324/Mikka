import { Pool } from 'pg'
import { test, expect, registerInTeam } from './fixtures'
import { attachLightDark } from './settings-v4-shots'

// 密钥与登录 › 工作区 (was N5 密钥与环境) against the real secrets store (ephemeral WORKSPACE_SECRETS_KEY).
test('管理员添加、批量添加、改说明和删除密钥，值不回显，顶部切换回我的', async ({ page }, testInfo) => {
  await registerInTeam(page, '/settings?section=secrets')
  await expect(page.getByRole('heading', { level: 1, name: '密钥与环境' })).toBeVisible()
  const side = page.getByRole('group', { name: '密钥归属' })
  await expect(side.getByRole('button', { name: 'E2E 团队' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('还没有密钥。')).toBeVisible()
  // The E2B key is personal now: it is under 账号 › 模型与订阅, not the workspace's secrets.
  await expect(page.getByRole('region', { name: '云电脑' })).toHaveCount(0)
  await attachLightDark(page, testInfo, 'secrets-empty')

  const value = `e2e-${Date.now()}-value`
  await page.getByRole('button', { name: '添加', exact: true }).first().click()
  let sheet = page.getByRole('dialog', { name: '添加密钥' })
  await expect(sheet.getByRole('switch', { name: '在输出里遮住' })).toBeChecked()
  await sheet.getByLabel('名称', { exact: true }).fill('VERCEL_TOKEN')
  await sheet.getByLabel('值', { exact: true }).fill(value)
  await sheet.getByLabel('说明', { exact: true }).fill('部署预览')
  await attachLightDark(page, testInfo, 'secrets-add')
  await sheet.getByRole('button', { name: '保存', exact: true }).click()
  // Everyone in the workspace can use it: asked once before saving.
  const confirm = page.getByRole('alertdialog', { name: 'E2E 团队 的所有成员都能用 VERCEL_TOKEN？' })
  await confirm.getByRole('button', { name: '保存', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  const table = page.getByRole('table')
  await expect(table.getByRole('row').filter({ hasText: 'VERCEL_TOKEN' })).toContainText('部署预览')

  await page.getByRole('button', { name: '添加', exact: true }).first().click()
  sheet = page.getByRole('dialog', { name: '添加密钥' })
  await sheet.getByRole('button', { name: '仓库', exact: true }).click()
  await sheet.getByLabel('仓库', { exact: true }).fill('alexj11324/mikka')
  await sheet.getByLabel('名称', { exact: true }).fill('NODE_ENV')
  await sheet.getByLabel('值', { exact: true }).fill('production')
  await sheet.getByRole('switch', { name: '在输出里遮住' }).click()
  await sheet.getByRole('button', { name: '保存', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  const nodeEnv = table.getByRole('row').filter({ hasText: 'NODE_ENV' })
  await expect(nodeEnv).toContainText('alexj11324/mikka')
  await expect(nodeEnv).toContainText('不遮住')
  expect(await page.content()).not.toContain(value)

  // Bulk add: names previewed, the reserved line reported, values never shown.
  await page.getByRole('button', { name: '批量添加', exact: true }).first().click()
  sheet = page.getByRole('dialog', { name: '批量添加' })
  await sheet.getByLabel('.env', { exact: true }).fill('SENTRY_DSN=https://example.invalid/1 # 报错\nPATH=/usr/bin\nTURBO_TOKEN="bulk-value-123"')
  await expect(sheet.getByText('2 个可添加')).toBeVisible()
  await expect(sheet.getByText('第 2 行 · PATH 是保留名称')).toBeVisible()
  await attachLightDark(page, testInfo, 'secrets-bulk')
  await sheet.getByRole('button', { name: '添加 2 个', exact: true }).click()
  await page.getByRole('alertdialog', { name: 'E2E 团队 的所有成员都能用这 2 个密钥？' }).getByRole('button', { name: '添加 2 个', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已添加 2 个，替换 0 个，跳过 1 个。' })).toBeVisible()
  await expect(table.getByRole('row').filter({ hasText: 'SENTRY_DSN' })).toContainText('报错')
  await expect(table.getByRole('row').filter({ hasText: 'TURBO_TOKEN' })).toBeVisible()
  expect(await page.content()).not.toContain('bulk-value-123')
  await attachLightDark(page, testInfo, 'secrets-list')

  // A note-only edit keeps the value; deleting asks first.
  await table.getByRole('row').filter({ hasText: 'VERCEL_TOKEN' }).getByRole('button', { name: 'VERCEL_TOKEN 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
  sheet = page.getByRole('dialog', { name: 'VERCEL_TOKEN' })
  await expect(sheet.getByLabel('新的值', { exact: true })).toHaveValue('')
  await expect(sheet.getByRole('switch', { name: '在输出里遮住' })).toBeDisabled()
  await sheet.getByLabel('说明', { exact: true }).fill('生产部署')
  await sheet.getByRole('button', { name: '保存', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  await expect(table.getByRole('row').filter({ hasText: 'VERCEL_TOKEN' })).toContainText('生产部署')
  await table.getByRole('row').filter({ hasText: 'VERCEL_TOKEN' }).getByRole('button', { name: 'VERCEL_TOKEN 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
  sheet = page.getByRole('dialog', { name: 'VERCEL_TOKEN' })
  await sheet.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('alertdialog', { name: '删除 VERCEL_TOKEN？' }).getByRole('button', { name: '删除', exact: true }).click()
  await expect(table.getByText('VERCEL_TOKEN')).toHaveCount(0)

  // The switch at the top: 我的 is the person's own logins, the same page.
  await side.getByRole('button', { name: '我的', exact: true }).click()
  await expect(page.getByRole('region', { name: '网站登录' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: '密钥与登录' })).toBeVisible()
  await expect(side.getByRole('button', { name: '我的', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await side.getByRole('button', { name: 'E2E 团队', exact: true }).click()
  await expect(table.getByText('TURBO_TOKEN')).toBeVisible()
})

// Members see every entry and write repository entries only; they never delete (lib/secrets/permissions.ts).
test('成员能看到全部密钥，只能添加和编辑仓库级的', async ({ page }, testInfo) => {
  const { workspaceId } = await registerInTeam(page, '/settings?section=secrets')
  await page.getByRole('button', { name: '添加', exact: true }).first().click()
  let sheet = page.getByRole('dialog', { name: '添加密钥' })
  await sheet.getByLabel('名称', { exact: true }).fill('VERCEL_TOKEN')
  await sheet.getByLabel('值', { exact: true }).fill(`e2e-${Date.now()}-admin`)
  await sheet.getByLabel('说明', { exact: true }).fill('只有管理员能改')
  await sheet.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '保存', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL })
  try { await pool.query(`UPDATE mikka_workspace_members SET role='member' WHERE "workspaceId"=$1`, [workspaceId]) } finally { await pool.end() }
  await page.reload()

  // 密钥与环境 is in a member's sidebar now.
  await expect(page.getByRole('button', { name: '密钥与环境' }).or(page.getByRole('link', { name: '密钥与环境' })).first()).toBeVisible()
  const table = page.getByRole('table')
  const adminRow = table.getByRole('row').filter({ hasText: 'VERCEL_TOKEN' })
  await expect(adminRow).toContainText('只有管理员能改')
  await expect(adminRow.getByRole('button', { name: 'VERCEL_TOKEN 的操作' })).toHaveCount(0)
  await attachLightDark(page, testInfo, 'secrets-member-list')
  await page.getByRole('button', { name: '添加', exact: true }).first().click()
  sheet = page.getByRole('dialog', { name: '添加密钥' })
  await expect(sheet.getByRole('button', { name: '仓库', exact: true })).toHaveCount(0)
  await sheet.getByLabel('仓库', { exact: true }).fill('alexj11324/mikka')
  await sheet.getByLabel('名称', { exact: true }).fill('SENTRY_DSN')
  await sheet.getByLabel('值', { exact: true }).fill(`e2e-${Date.now()}-member`)
  await attachLightDark(page, testInfo, 'secrets-member-add')
  await sheet.getByRole('button', { name: '保存', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  await expect(table.getByRole('row').filter({ hasText: 'SENTRY_DSN' })).toContainText('alexj11324/mikka')

  await table.getByRole('row').filter({ hasText: 'SENTRY_DSN' }).getByRole('button', { name: 'SENTRY_DSN 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
  sheet = page.getByRole('dialog', { name: 'SENTRY_DSN' })
  await expect(sheet.getByLabel('新的值', { exact: true })).toBeVisible()
  await expect(sheet.getByRole('button', { name: '删除', exact: true })).toHaveCount(0)
})

// Keys are personal (orchestration § 2): every member, admin or not, sets their own E2B key
// under 账号 › 模型与订阅, and the team's 密钥与环境 no longer holds one.
test('团队成员在模型与订阅里设置自己的 E2B Key', async ({ page }, testInfo) => {
  const { workspaceId } = await registerInTeam(page, '/settings?section=models')
  // A plain member, not an admin, still edits their own key.
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL })
  try { await pool.query(`UPDATE mikka_workspace_members SET role='member' WHERE "workspaceId"=$1`, [workspaceId]) } finally { await pool.end() }
  await page.reload()
  // The key has its own row under 运行位置, shown with 本地 selected too: the bot's own cloud computer uses it as well.
  const location = page.getByRole('region', { name: '运行位置' })
  await expect(location.getByRole('button', { name: '本地' }).or(location.getByRole('radio', { name: '本地' }))).toHaveAttribute('aria-pressed', 'true')
  await expect(location.getByText('E2B Key', { exact: true })).toBeVisible()
  await expect(location.getByRole('status').filter({ hasText: '未填' })).toBeVisible()
  await attachLightDark(page, testInfo, 'models-e2b')
  await location.getByRole('button', { name: '填入', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'E2B API Key' }).getByLabel('API Key')).toHaveValue('')
  await attachLightDark(page, testInfo, 'models-e2b-dialog')
})
