import { test, expect, register } from './fixtures'

// Real application, normal allocated account and browser interaction. Only the
// computer-policy response is a bounded UI fixture. The actual PostgreSQL policy
// and owner/deny enforcement run in the mandatory cloud/computer database suites.
test('电脑策略可以选择并重载允许，非管理员不能修改', async ({ page }, testInfo) => {
  let permission: 'allow' | 'ask' | 'deny' = 'ask'
  let canEdit = true
  const writes: string[] = []
  await page.route('**/api/workspaces/*/computer-policy', async route => {
    if (route.request().method() === 'POST') {
      const value = route.request().postDataJSON()?.permission
      expect(['allow', 'ask', 'deny']).toContain(value)
      expect(canEdit).toBe(true)
      permission = value
      writes.push(value)
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, permission, canEdit }) })
  })
  await register(page, '/settings?section=workspace')
  const controls = page.getByRole('toolbar', { name: 'Bot 操作电脑', exact: true })
  const allow = controls.getByRole('button', { name: '允许', exact: true })
  const ask = controls.getByRole('button', { name: '操作前审批', exact: true })
  const deny = controls.getByRole('button', { name: '禁止', exact: true })
  await expect(ask).toHaveAttribute('aria-pressed', 'true')
  await allow.click()
  await expect(allow).toHaveAttribute('aria-pressed', 'true')
  await expect(allow).toBeEnabled()
  expect(writes).toEqual(['allow'])
  await page.reload()
  await expect(allow).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('alert').filter({ hasText: '无法读取或更新电脑设置。' })).toHaveCount(0)
  await testInfo.attach('computer-policy-allow', { body: await controls.screenshot(), contentType: 'image/png' })
  await deny.click()
  await expect(deny).toHaveAttribute('aria-pressed', 'true')
  await expect(ask).toBeEnabled()
  await ask.click()
  await expect(ask).toHaveAttribute('aria-pressed', 'true')
  await expect(ask).toBeEnabled()
  expect(writes).toEqual(['allow', 'deny', 'ask'])
  canEdit = false
  await page.reload()
  await expect(allow).toBeDisabled()
  await expect(ask).toBeDisabled()
  await expect(deny).toBeDisabled()
  expect(writes).toEqual(['allow', 'deny', 'ask'])
})
