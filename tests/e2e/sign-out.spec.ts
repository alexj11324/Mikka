import { randomUUID } from 'node:crypto'
import { test, expect, register, rail, app, seedTask, openIssueFromSearch } from './fixtures'

test.use({ expectedConsoleErrors: [{ path: app('/api/auth/sign-out'), message: 'Failed to load resource: the server responded with a status of 400 (Bad Request)' }] })

for (const path of ['/', '/settings/members', '/en/devices', '/devices']) {
  test(`sign-out hides private UI while pending, restores failures, and revokes the session: ${path}`, async ({ page, context }) => {
    const english = path.startsWith('/en/')
    const mobile = path === '/devices'
    if (mobile) await page.setViewportSize({ width: 390, height: 844 })
    await register(page, english ? '/devices' : path)
    if (english) await page.goto(app(path))
    const accountMenu = page.getByRole('button', { name: path.includes('devices') ? english ? 'Account menu' : '账户菜单' : '工作区菜单', exact: true })
    const pending = page.getByRole('status', { name: english ? 'Signing out…' : '正在退出…', exact: true })
    const cookie = (await context.cookies()).map(value => `${value.name}=${value.value}`).join('; ')
    const session = await page.request.get(app('/api/auth/get-session'))
    expect((await session.json()).user).toBeTruthy()

    let release!: (fail: boolean) => void
    const routePattern = '**/api/auth/sign-out'
    const hold = async () => {
      const gate = new Promise<boolean>(resolve => { release = resolve })
      // Measure the reserved scrollbar gutter before any overlay locks scrolling (with html `scrollbar-gutter: stable`, documentElement.clientWidth here still equals innerWidth, while body.clientWidth excludes the reserved gutter, so measure on body).
      const gutter = await page.evaluate(() => innerWidth - document.body.clientWidth)
      await page.route(routePattern, async route => {
        if (await gate) await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'SIGN_OUT_FAILED', message: 'Sign out failed' }) })
        else await route.continue()
      })
      if (mobile && !await accountMenu.isVisible()) await page.getByRole('button', { name: '展开或收起侧栏', exact: true }).click()
      await accountMenu.click()
      await page.getByRole('menuitem', { name: english ? 'Sign out' : '退出登录', exact: true }).click()
      await expect(pending).toBeVisible()
      await page.keyboard.press('ControlOrMeta+k')
      await page.keyboard.press('c')
      if (mobile) {
        const sheet = page.locator('[data-slot="sidebar"][data-mobile="true"]')
        await expect(sheet).toHaveAttribute('data-open', '')
        for (let attempt = 0; attempt < 2; attempt++) {
          await page.keyboard.press('ControlOrMeta+b')
          // Let the Sheet's 200 ms close transition finish before attempting to reopen it.
          await page.waitForTimeout(250)
          await expect(sheet).toHaveAttribute('data-open', '')
        }
      }
      const pendingDialog = page.getByRole('dialog', { name: english ? 'Signing out…' : '正在退出…', exact: true })
      await expect(pendingDialog).toBeVisible()
      for (const key of ['Tab', 'Shift+Tab', 'Escape']) {
        await page.keyboard.press(key)
        await expect(pendingDialog).toBeFocused()
      }
      await expect(page.getByRole('dialog')).toHaveCount(1)
      // html reserves a stable scrollbar gutter, so the fixed overlay is exactly the measured gutter narrower than the viewport.
      const box = (await pendingDialog.boundingBox())!
      const viewport = page.viewportSize()!
      expect({ x: box.x, y: box.y, height: box.height }).toEqual({ x: 0, y: 0, height: viewport.height })
      expect(Math.abs(box.width - (viewport.width - gutter))).toBeLessThanOrEqual(1)
      await expect(accountMenu).toHaveCount(0)
      await expect(page.getByRole('heading').filter({ hasNotText: english ? 'Signing out…' : '正在退出…' })).toHaveCount(0)
      for (const name of await page.locator('[hidden][inert]').getByText('回归测试成员', { exact: true }).all()) await expect(name).not.toBeVisible()
    }

    await hold()
    release(true)
    await expect(pending).not.toBeVisible()
    if (mobile) {
      await page.keyboard.press('Escape')
      await expect(page.locator('[data-slot="sidebar"][data-mobile="true"]')).not.toBeVisible()
    }
    if (!mobile) await expect(accountMenu).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: english ? 'Sign out failed.' : '退出失败。' })).toBeVisible()
    expect((await (await page.request.get(app('/api/auth/get-session'))).json()).user).toBeTruthy()
    await page.unroute(routePattern)

    await hold()
    release(false)
    await expect(page).toHaveURL(url => url.pathname === app(`${english ? '/en' : ''}/sign-in`) && url.searchParams.get('login') === '1')
    await expect(page.getByRole('heading', { name: english ? 'Welcome back' : '欢迎回来', exact: true })).toBeVisible()
    // Replaying the original cookie proves revocation on the server, beyond browser cookie removal.
    const revoked = await page.request.get(app('/api/auth/get-session'), { headers: { cookie } })
    expect(await revoked.json()).toBeNull()
  })
}

test('sign-out waits for editor validation and preserves saved edits when revocation fails', async ({ page }) => {
  await register(page)
  const original = `退出保存 ${randomUUID()}`
  await seedTask(page, original)
  await page.reload()
  await rail(page, '看板').click()
  await openIssueFromSearch(page, original)
  const title = page.getByLabel('任务标题', { exact: true })
  await expect(title).toHaveValue(original)
  await expect(page.getByRole('button', { name: '更多任务操作', exact: true })).toBeEnabled()
  let requests = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/auth/sign-out', async route => {
    requests++
    await gate
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'SIGN_OUT_FAILED', message: 'Sign out failed' }) })
  })
  async function signOut() {
    await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
  }
  await title.fill('')
  await signOut()
  await expect(page.getByRole('alert').filter({ hasText: '任务标题不能为空，修改未保存。' })).toBeVisible()
  await expect(title).toHaveValue('')
  expect(requests).toBe(0)
  await expect(page.getByRole('status', { name: '正在退出…', exact: true })).toHaveCount(0)

  const updated = `${original} 已保存`
  await title.fill(updated)
  await signOut()
  await expect(page.getByRole('status', { name: '正在退出…', exact: true })).toBeVisible()
  await expect(title).not.toBeVisible()
  release()
  await expect(title).toHaveValue(updated)
  await expect(page.getByRole('alert').filter({ hasText: '退出失败。' })).toBeVisible()
  await page.reload()
  await expect(title).toHaveValue(updated)
})

test('failed sign-out preserves an invalid project draft and its validation error', async ({ page }) => {
  await register(page)
  await page.goto(app('/?section=projects'))
  await page.getByRole('button', { name: '新建项目', exact: true }).first().click()
  const create = page.getByRole('dialog', { name: '新建项目', exact: true })
  await create.getByLabel('项目名称', { exact: true }).fill(`退出项目 ${randomUUID()}`)
  await create.getByRole('button', { name: '创建项目', exact: true }).click()
  await expect(create).not.toBeVisible()
  const name = page.getByRole('textbox', { name: '项目名称', exact: true })
  await expect(name).toBeVisible()
  await name.fill('')
  await name.press('Tab')
  await expect(page.getByText('项目名称不能为空', { exact: true })).toBeVisible()

  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/auth/sign-out', async route => {
    await gate
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'SIGN_OUT_FAILED', message: 'Sign out failed' }) })
  })
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
  await expect(page.getByRole('status', { name: '正在退出…', exact: true })).toBeVisible()
  await expect(name).toHaveCount(0)
  const mountedName = page.locator('[role="textbox"][aria-label="项目名称"]')
  await expect(mountedName).toHaveCount(1)
  await expect(mountedName).not.toBeVisible()
  await expect(mountedName.locator('xpath=ancestor::*[@inert]')).toHaveCount(1)

  release()
  await expect(name).toBeVisible()
  await expect(name).toHaveText('')
  await expect(name).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('项目名称不能为空', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: '退出失败。' })).toBeVisible()
})
