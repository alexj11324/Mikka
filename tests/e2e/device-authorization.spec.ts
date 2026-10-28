import { test, expect, register, app } from './fixtures'

test('a device grant is reviewed in the browser and exchanged for a daemon credential', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  await register(page, '/settings?section=devices')
  await page.getByRole('button', { name: '连接设备', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '连接电脑', exact: true })
  await expect(dialog).toContainText('npm install --global')
  await expect(dialog).toContainText('mikka daemon login --server')
  await expect(dialog).toContainText(new URL(page.url()).origin + app('/'))
  await expect(dialog).not.toContainText('pnpm daemon')
  await expect(dialog.getByRole('textbox')).toHaveCount(0)
  await testInfo.attach('connect-device-light', { body: await page.screenshot(), contentType: 'image/png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await testInfo.attach('connect-device-dark', { body: await page.screenshot(), contentType: 'image/png' })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 390, height: 844 })
  await testInfo.attach('connect-device-narrow', { body: await page.screenshot(), contentType: 'image/png' })
  await page.setViewportSize({ width: 1440, height: 960 })
  await dialog.getByRole('button', { name: '完成', exact: true }).click()

  const before = await (await page.request.get(app('/api/auth/get-session'))).json()
  // The daemon has its own cookie-free HTTP client. page.request shares the
  // browser's session cookies, so its missing Origin correctly fails CSRF.
  const grantResponse = await request.post(app('/api/auth/device/code'), { data: { client_id: 'mikka-daemon' } })
  expect(grantResponse.status()).toBe(200)
  const grant = await grantResponse.json()
  expect(new URL(grant.verification_uri).pathname).toBe(app('/device'))
  await page.goto(grant.verification_uri_complete)
  await expect(page.getByRole('heading', { name: '连接这台电脑', exact: true })).toBeVisible()
  await expect(page.getByText(grant.user_code, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '允许', exact: true })).toBeEnabled()
  await testInfo.attach('device-code-review-light', { body: await page.screenshot(), contentType: 'image/png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await testInfo.attach('device-code-review-dark', { body: await page.screenshot(), contentType: 'image/png' })
  await page.emulateMedia({ colorScheme: 'light' })
  // Hold only delivery of the real approval response while capturing pending UI.
  let releaseApproval!: () => void
  const approvalReleased = new Promise<void>(resolve => { releaseApproval = resolve })
  const approvalPath = '**/api/auth/device/approve'
  await page.route(approvalPath, async route => {
    const actual = await route.fetch()
    await approvalReleased
    await route.fulfill({ response: actual })
  })
  try {
    await page.getByRole('button', { name: '允许', exact: true }).click()
    await expect(page.getByRole('button', { name: '正在批准…', exact: true })).toBeDisabled()
    await testInfo.attach('device-code-approving', { body: await page.screenshot(), contentType: 'image/png' })
  } finally { releaseApproval() }
  await expect(page.getByRole('heading', { name: '已批准', exact: true })).toBeVisible()
  await page.unroute(approvalPath)
  await testInfo.attach('device-code-approved', { body: await page.screenshot(), contentType: 'image/png' })

  const tokenResponse = await request.post(app('/api/auth/device/token'), {
    data: { client_id: 'mikka-daemon', device_code: grant.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
  })
  expect(tokenResponse.status()).toBe(200)
  const credential = await tokenResponse.json()
  expect(credential.access_token).toMatch(/^orv_[A-Za-z0-9_-]{43}$/)
  expect(credential.scope).toBe('device')
  expect((await request.storageState()).cookies).toEqual([])
  const after = await (await page.request.get(app('/api/auth/get-session'))).json()
  expect(after.session.id).toBe(before.session.id)
  const replay = await request.post(app('/api/auth/device/token'), {
    data: { client_id: 'mikka-daemon', device_code: grant.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
  })
  expect(replay.status()).toBe(400)

  const denied = await (await request.post(app('/api/auth/device/code'), { data: { client_id: 'mikka-daemon' } })).json()
  await page.goto(denied.verification_uri_complete)
  await page.getByRole('button', { name: '拒绝', exact: true }).click()
  await expect(page.getByRole('heading', { name: '已拒绝', exact: true })).toBeVisible()
  await testInfo.attach('device-code-denied', { body: await page.screenshot(), contentType: 'image/png' })
  const denial = await request.post(app('/api/auth/device/token'), {
    data: { client_id: 'mikka-daemon', device_code: denied.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
  })
  expect((await denial.json()).error).toBe('access_denied')

  await page.goto(app('/device'))
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('textbox', { name: '终端验证码', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '终端验证码', exact: true }).fill('x')
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('验证码无效或已过期')
  await testInfo.attach('device-code-invalid-narrow', { body: await page.screenshot(), contentType: 'image/png' })
  await page.getByRole('button', { name: '重新输入', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '终端验证码', exact: true })).toHaveValue('')
})
