import { test, expect, register } from './fixtures'

for (const { platform, modifier } of [
  { platform: 'macOS', modifier: '⌘' },
  { platform: 'Windows', modifier: 'Ctrl' },
  { platform: 'Linux', modifier: 'Ctrl' },
]) {
  test(`${platform} 自动识别设备，每个快捷键使用独立键帽`, async ({ page }) => {
    await page.addInitScript(platformName => {
      Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { platform: platformName } })
    }, platform)
    await register(page)
    await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
    const settings = page.getByRole('menuitem', { name: '设置', exact: true })
    await expect(settings.locator('[data-slot="kbd-group"]')).toHaveCount(1)
    await expect(settings.locator('[data-slot="kbd"]')).toHaveText([modifier, ','])
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '搜索任务', exact: true }).hover()
    await expect(page.getByRole('tooltip').locator('[data-slot="kbd"]')).toHaveText([modifier, 'K'])
    await page.getByRole('button', { name: '新建任务', exact: true }).click()
    const create = page.getByRole('dialog', { name: '新建任务', exact: true })
    await expect(create.locator('footer [data-slot="kbd"]')).toHaveText([modifier, 'Enter'])
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '打开全局搜索', exact: true }).focus()
    await page.keyboard.press(platform === 'macOS' ? 'Meta+,' : 'Control+,')
    await expect(page).toHaveURL(/\/settings/)
  })
}

test('KBD 提示匹配真实快捷键，输入内容不会误触新建或设置', async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  const settings = page.getByRole('menuitem', { name: '设置', exact: true })
  const modifier = await page.evaluate(() => /Mac|iPhone|iPad|iPod/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl')
  await expect(settings.locator('[data-slot="kbd"]')).toHaveText([modifier, ','])
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+k')
  const search = page.getByRole('dialog', { name: '搜索任务', exact: true })
  await expect(search).toBeVisible()
  await expect(search.locator('[data-slot="kbd"]')).toHaveText(['↑', '↓', 'Enter', 'Esc'])
  await search.getByRole('combobox', { name: '全局搜索任务', exact: true }).fill('c')
  await page.keyboard.press('Control+,')
  await expect(search).toBeVisible()
  await expect(page.getByRole('dialog', { name: '新建任务', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '打开全局搜索', exact: true }).focus()
  await page.keyboard.press('c')
  const create = page.getByRole('dialog', { name: '新建任务', exact: true })
  await expect(create).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '打开全局搜索', exact: true }).focus()
  await page.keyboard.press('Control+,')
  await expect(page).toHaveURL(/\/settings/)
})
