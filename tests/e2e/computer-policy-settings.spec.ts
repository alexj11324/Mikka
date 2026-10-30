import { test, expect, register } from './fixtures'

// Real application, normal allocated account and browser interaction. Only the
// computer-policy response is a bounded UI fixture. The actual PostgreSQL policy
// and owner/deny enforcement run in the mandatory cloud/computer database suites.
test('电脑策略默认允许，可以禁止再允许，非管理员不能修改', async ({ page }, testInfo) => {
  let permission: 'allow' | 'deny' = 'allow'
  let canEdit = true
  const writes: string[] = []
  await page.route('**/api/workspaces/*/computer-policy', async route => {
    if (route.request().method() === 'POST') {
      const value = route.request().postDataJSON()?.permission
      expect(['allow', 'deny']).toContain(value)
      expect(canEdit).toBe(true)
      permission = value
      writes.push(value)
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, permission, canEdit }) })
  })
  await register(page, '/settings?section=permissions')
  const controls = page.getByRole('group', { name: 'Bot 操作电脑', exact: true })
  const allow = controls.getByRole('button', { name: '允许（默认）', exact: true })
  const deny = controls.getByRole('button', { name: '禁止', exact: true })
  // Per-step approval was retired on 2026-10-30.
  await expect(controls.getByRole('button')).toHaveCount(2)
  await expect(allow).toHaveAttribute('aria-pressed', 'true')
  await deny.click()
  await expect(deny).toHaveAttribute('aria-pressed', 'true')
  await expect(deny).toBeEnabled()
  expect(writes).toEqual(['deny'])
  await page.reload()
  await expect(deny).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('alert').filter({ hasText: '无法读取或更新电脑设置。' })).toHaveCount(0)
  await allow.click()
  await expect(allow).toHaveAttribute('aria-pressed', 'true')
  await testInfo.attach('computer-policy-allow', { body: await controls.screenshot(), contentType: 'image/png' })
  expect(writes).toEqual(['deny', 'allow'])
  canEdit = false
  await page.reload()
  await expect(allow).toBeDisabled()
  await expect(deny).toBeDisabled()
  expect(writes).toEqual(['deny', 'allow'])
})
