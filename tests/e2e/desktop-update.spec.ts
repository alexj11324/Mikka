import { test, expect, register } from './fixtures'

// The desktop preload's update contract (packages/protocol/src/bridge.ts),
// stood in for: the browser suite runs no Electron. The main-process side is
// covered by apps/desktop/src/main/updates.test.ts.
test('桌面版：更新下载好后，头像上方出现重启更新按钮，点击安装', async ({ page }) => {
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
  await update.hover()
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText('重启以更新到 v0.2.0')
  await update.click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { updateCalls: string[] }).updateCalls)).toEqual(['install'])
})
