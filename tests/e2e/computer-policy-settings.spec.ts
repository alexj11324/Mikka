import { test, expect, registerInTeam } from './fixtures'

// Real application, normal allocated account and browser interaction. Only the
// computer-policy response is a bounded UI fixture. The actual PostgreSQL policy
// and owner/deny enforcement run in the mandatory cloud/computer database suites.
test('电脑操作默认允许，可以禁止再允许，非管理员只看到当前值', async ({ page }, testInfo) => {
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
  await registerInTeam(page, '/settings?section=permissions')
  await expect(page.getByRole('heading', { name: '电脑操作', exact: true })).toBeVisible()
  const controls = page.getByRole('group', { name: 'Bot 操作电脑', exact: true })
  const allow = controls.getByRole('button', { name: '允许', exact: true })
  const deny = controls.getByRole('button', { name: '禁止', exact: true })
  // Per-step approval was retired on 2026-10-30: only 允许 and 禁止 remain.
  await expect(controls.getByRole('button')).toHaveCount(2)
  await expect(allow).toHaveAttribute('aria-pressed', 'true')
  await testInfo.attach('computer-policy-allow', { body: await controls.screenshot(), contentType: 'image/png' })
  await deny.click()
  await expect(deny).toHaveAttribute('aria-pressed', 'true')
  await expect(deny).toBeEnabled()
  expect(writes).toEqual(['deny'])
  await page.reload()
  await expect(deny).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('alert').filter({ hasText: '无法读取或更新电脑设置。' })).toHaveCount(0)
  await allow.click()
  await expect(allow).toHaveAttribute('aria-pressed', 'true')
  expect(writes).toEqual(['deny', 'allow'])
  canEdit = false
  await page.reload()
  // Non-admins see the value as text, with no control they cannot use. 团队权限 also lists
  // 允许使用的应用, whose app selects read 允许 too, so look inside the 电脑操作 section.
  const section = page.getByRole('region', { name: '电脑操作', exact: true })
  await expect(section.getByText('允许', { exact: true })).toBeVisible()
  await expect(controls).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(允许|禁止)$/ })).toHaveCount(0)
  expect(writes).toEqual(['deny', 'allow'])
})
