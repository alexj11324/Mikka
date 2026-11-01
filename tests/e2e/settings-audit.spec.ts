import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { recordAuthenticationSecrets } from '../../scripts/test-accounts/session.mjs'
import { test, expect, registerInTeam, app } from './fixtures'
import { attachLightDark } from './settings-v4-shots'

// N6 审计日志 (Figma 554:9417): a real write (an address change in 常规) shows up for the admin.
test('审计日志按天列出地址修改，可筛选安全并导出 CSV', async ({ page }, testInfo) => {
  await registerInTeam(page, '/settings?section=audit')
  await expect(page.getByRole('heading', { level: 1, name: '审计日志' })).toBeVisible()
  await expect(page.getByText('最近 90 天没有记录。')).toBeVisible()
  await attachLightDark(page, testInfo, 'audit-empty')

  // A new workspace has no address yet; the first one is set, the second change is audited.
  await page.goto(page.url().replace('section=audit', 'section=general'))
  const address = page.getByRole('textbox', { name: '地址', exact: true })
  const first = `e2e-${randomUUID().slice(0, 8)}`, second = `e2e-${randomUUID().slice(0, 8)}`
  for (const slug of [first, second]) {
    await address.fill(slug)
    await address.press('Enter')
    await expect(address).toHaveValue(slug)
    await expect(address).toBeEnabled()
  }

  // Workspace changes enqueue durably; exercise the same authenticated HTTP tick
  // used by the minute worker before reading the real audit sink through the UI.
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) throw new Error('Audit browser acceptance requires its isolated test CRON_SECRET')
  if (process.env.MIKKA_TEST_ENVIRONMENT_FILE) await recordAuthenticationSecrets([cronSecret])
  const tick = await page.request.get(new URL(app('/api/cron/audit-retention'), page.url()).href, {
    headers: { authorization: `Bearer ${cronSecret}` }, maxRedirects: 0,
  })
  expect(tick.status()).toBe(200)
  const maintenance = await tick.json()
  expect(maintenance.error).toBeUndefined()
  expect(maintenance.delivery.failed).toBe(0)
  // A natural minute tick may already have delivered it; the own-row UI and CSV
  // assertions below are the readback, rather than a global batch counter.
  expect(maintenance.delivery.delivered).toBeGreaterThanOrEqual(0)

  await page.goto(page.url().replace('section=general', 'section=audit'))
  await expect(page.getByRole('heading', { level: 2, name: '今天' })).toBeVisible()
  await expect(page.getByText(`把地址从 ${first} 改为 ${second}`)).toBeVisible()
  await attachLightDark(page, testInfo, 'audit-list')

  await page.getByRole('button', { name: '安全', exact: true }).click()
  await expect(page.getByText(`把地址从 ${first} 改为 ${second}`)).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: '导出 CSV' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.csv$/)
  const downloaded = await file.path()
  expect(downloaded).not.toBeNull()
  expect((await readFile(downloaded!, 'utf8')).includes('workspace.slug_changed')).toBe(true)
})
