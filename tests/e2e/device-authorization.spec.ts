import { test, expect, register, app } from './fixtures'

test('a device grant is reviewed in the browser and exchanged for a daemon credential', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  await register(page, '/settings?section=devices')
  await page.getByRole('button', { name: '连接设备', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '连接电脑', exact: true })
  await expect(dialog).toContainText('npm install --global')
  await expect(dialog).toContainText('mikka daemon login --server')
  await expect(dialog).toContainText(new URL(page.url()).origin + app('/'))
  await expect(dialog).not.toContainText('pnpm daemon')
  await testInfo.attach('connect-device-light', { body: await page.screenshot(), contentType: 'image/png' })
  await dialog.getByRole('button', { name: '完成', exact: true }).click()

  const before = await (await page.request.get(app('/api/auth/get-session'))).json()
  const grantResponse = await page.request.post(app('/api/auth/device/code'), { data: { client_id: 'mikka-daemon' } })
  expect(grantResponse.status()).toBe(200)
  const grant = await grantResponse.json()
  expect(new URL(grant.verification_uri).pathname).toBe(app('/device'))
  await page.goto(grant.verification_uri_complete)
  await expect(page.getByRole('heading', { name: '连接这台电脑', exact: true })).toBeVisible()
  await expect(page.getByText(grant.user_code, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '允许', exact: true })).toBeEnabled()
  await testInfo.attach('device-code-review-light', { body: await page.screenshot(), contentType: 'image/png' })
  await page.getByRole('button', { name: '允许', exact: true }).click()
  await expect(page.getByRole('heading', { name: '已批准', exact: true })).toBeVisible()

  const tokenResponse = await page.request.post(app('/api/auth/device/token'), {
    data: { client_id: 'mikka-daemon', device_code: grant.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
  })
  expect(tokenResponse.status()).toBe(200)
  const credential = await tokenResponse.json()
  expect(credential.access_token).toMatch(/^orv_[A-Za-z0-9_-]{43}$/)
  expect(credential.scope).toBe('device')
  const after = await (await page.request.get(app('/api/auth/get-session'))).json()
  expect(after.session.id).toBe(before.session.id)
  const replay = await page.request.post(app('/api/auth/device/token'), {
    data: { client_id: 'mikka-daemon', device_code: grant.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
  })
  expect(replay.status()).toBe(400)

  const denied = await (await page.request.post(app('/api/auth/device/code'), { data: { client_id: 'mikka-daemon' } })).json()
  await page.goto(denied.verification_uri_complete)
  await page.getByRole('button', { name: '拒绝', exact: true }).click()
  await expect(page.getByRole('heading', { name: '已拒绝', exact: true })).toBeVisible()
  const denial = await page.request.post(app('/api/auth/device/token'), {
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
