import { test, expect, register } from './fixtures'

// The desktop preload's update contract (packages/protocol/src/bridge.ts),
// stood in for: the browser suite runs no Electron. The main-process side is
// covered by apps/desktop/src/main/updates.test.ts.
test('桌面版：更新下载好后，头像上方出现重启更新按钮，点击安装', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await register(page)
  const rail = page.getByRole('navigation', { name: '主导航', exact: true })
  const update = rail.getByRole('button', { name: '重启以更新到 v0.2.0', exact: true })
  const avatar = rail.getByRole('button', { name: '工作区菜单' })
  await expect(avatar).toBeVisible()
  await expect(rail.getByRole('button', { name: /重启以更新/ })).toHaveCount(0)

  await page.addInitScript(() => {
    const noop = async () => {}
    const calls: string[] = []
    ;(window as unknown as { updateCalls: string[] }).updateCalls = calls
    ;(window as unknown as { mikka: unknown }).mikka = {
      app: {
        runtime: 'electron', version: 'e2e', flavor: 'dev', serverUrl: location.origin, zeroUrl: location.origin, openExternal: noop, prepareAuth: noop,
        updateReady: async () => '0.2.0',
        onUpdateReady: () => () => {},
        installUpdate: async () => { calls.push('install') },
      },
      notifications: { setBadge: noop, show: noop, onClick: () => () => {}, consumePendingClick: async () => null },
    }
  })
  await page.reload()

  await expect(update).toBeVisible()
  const [button, menu] = [(await update.boundingBox())!, (await avatar.boundingBox())!]
  expect(button.y + button.height).toBeLessThanOrEqual(menu.y)
  expect(Math.abs(button.x + button.width / 2 - (menu.x + menu.width / 2))).toBeLessThan(2)
  // The accent token, a 24px icon (the other items use 20px) and the same 36px target.
  expect(button.width).toBe(36)
  expect(button.height).toBe(36)
  const look = await update.evaluate(element => {
    const target = element as HTMLElement
    const color = getComputedStyle(target).color
    target.style.color = 'var(--sidebar-primary)'
    const accent = getComputedStyle(target).color
    target.style.color = ''
    return { color, accent, icon: target.querySelector('svg')!.getBoundingClientRect().width }
  })
  expect(look.color).toBe(look.accent)
  expect(look.icon).toBe(24)

  // Evidence for review: the bottom of the rail with the button, light and dark.
  const box = (await rail.boundingBox())!
  const clip = { x: box.x, y: menu.y - 120, width: box.width + 24, height: menu.y + menu.height - (menu.y - 120) + 16 }
  await testInfo.attach('update-button-light', { body: await page.screenshot({ clip }), contentType: 'image/png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/\bdark\b/)
  await testInfo.attach('update-button-dark', { body: await page.screenshot({ clip }), contentType: 'image/png' })

  await update.hover()
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText('重启以更新到 v0.2.0')
  await update.click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { updateCalls: string[] }).updateCalls)).toEqual(['install'])
})
