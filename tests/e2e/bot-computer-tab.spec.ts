import { Pool } from 'pg'
import { test, expect, register } from './fixtures'

// Every bot's right panel has 电脑 (decisions 2026-10-31). Mikka Cloud runs on the
// person's own E2B key: without one the screen offers 添加 E2B API Key, which opens
// the same dialog as API 与订阅; with one it is the bot's screen. Saving a key checks it
// against E2B, which no e2e run can reach, so the key row is written straight into the
// disposable database and the tab picks it up from the shared cache without a reload.
function e2eDatabase() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('The 电脑 tab spec requires E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Only the disposable E2E database is allowed')
  return new Pool({ connectionString, max: 1 })
}

test('电脑 tab: no E2B key offers 添加 E2B API Key; adding the key shows the screen, removing it brings the button back, no reload', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const { email } = await register(page)
  await page.getByRole('button', { name: '新建 Bot', exact: true }).first().click()
  const create = page.getByRole('dialog', { name: '新建 Bot' })
  await create.getByLabel('名字', { exact: true }).fill('云端助手')
  await create.getByRole('button', { name: '创建', exact: true }).click()
  await expect(create).toBeHidden()

  const panel = page.getByRole('complementary', { name: '右栏', exact: true })
  await panel.getByRole('tab', { name: '电脑', exact: true }).click()
  const add = panel.getByRole('button', { name: '添加 E2B API Key', exact: true })
  await expect(add).toBeVisible()
  await expect(panel.getByText('E2B API Key 未设置', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: '唤醒', exact: true })).toHaveCount(0)

  // The button opens the existing E2B API Key dialog.
  await add.click()
  const dialog = page.getByRole('dialog', { name: 'E2B API Key' })
  await expect(dialog.getByLabel('API Key')).toHaveValue('')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  const pool = e2eDatabase()
  try {
    const { rows: [member] } = await pool.query<{ workspaceId: string; userId: string }>(
      'SELECT m."workspaceId", m."userId" FROM mikka_workspace_members m JOIN "user" u ON u.id = m."userId" WHERE u.email = $1', [email])
    expect(member).toBeTruthy()
    // Status reads only whether the row exists; the ciphertext is never opened here.
    // The key is the person's own (keys are personal).
    await pool.query(`INSERT INTO user_e2b_keys ("userId", ciphertext, iv, "keyVersion", last4, "verifiedAt")
      VALUES ($1, 'e2e-not-a-key', 'e2e', 1, 'e2e0', now())`, [member.userId])
    const url = page.url()
    // The key changed outside this page: focus never re-reads it (decision
    // 2026-11-01-0400-no-refetch-on-focus), the next visit does.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(add).toBeVisible()
    const revisit = async (expectation: () => Promise<void>) => {
      await page.reload()
      await panel.getByRole('tab', { name: '电脑', exact: true }).click()
      await expectation()
    }
    await revisit(() => expect(panel.getByRole('button', { name: '唤醒', exact: true })).toBeVisible())
    await expect(panel.getByText('云端助手 的屏幕', { exact: true })).toBeVisible()
    await expect(add).toHaveCount(0)

    await pool.query('DELETE FROM user_e2b_keys WHERE "userId" = $1', [member.userId])
    await revisit(() => expect(add).toBeVisible())
    expect(page.url()).toBe(url)
  } finally { await pool.end() }
})
