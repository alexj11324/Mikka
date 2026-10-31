import { test, expect, register, rail, openCreateIssue, expectItems } from './fixtures'

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
    await expect(settings.locator('[data-slot="kbd"]')).toHaveCount(2)
    await expectItems(settings.locator('[data-slot="kbd"]'), [modifier, ','])
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '全局搜索', exact: true }).locator('[data-slot="kbd"]')).toHaveCount(2)
    await expectItems(page.getByRole('button', { name: '全局搜索', exact: true }).locator('[data-slot="kbd"]'), [modifier, 'K'])
    await rail(page, '看板').click()
    const create = await openCreateIssue(page)
    await expect(create.getByRole('button', { name: '创建任务', exact: true })).toHaveAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '全局搜索', exact: true }).focus()
    await page.keyboard.press(platform === 'macOS' ? 'Meta+,' : 'Control+,')
    await expect(page).toHaveURL(/\/settings/)
  })
}

test('KBD 提示匹配真实快捷键，输入内容不会误触新建或设置', async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  const settings = page.getByRole('menuitem', { name: '设置', exact: true })
  const modifier = await page.evaluate(() => /Mac|iPhone|iPad|iPod/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl')
  await expect(settings.locator('[data-slot="kbd"]')).toHaveCount(2)
  await expectItems(settings.locator('[data-slot="kbd"]'), [modifier, ','])
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+k')
  const search = page.getByRole('dialog', { name: '全局搜索', exact: true })
  await expect(search).toBeVisible()
  await search.getByRole('combobox', { name: '全局搜索', exact: true }).fill('c')
  await page.keyboard.press('Control+,')
  await expect(search).toBeVisible()
  await expect(page.getByRole('dialog', { name: '新建任务', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '全局搜索', exact: true }).focus()
  await page.keyboard.press('c')
  const create = page.getByRole('dialog', { name: '新建任务', exact: true })
  await expect(create).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '全局搜索', exact: true }).focus()
  await page.keyboard.press('Control+,')
  await expect(page).toHaveURL(/\/settings/)
})

test('顶部全局搜索次级按钮在真实页面有灰色填充且无可见描边', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await register(page)
  const search = page.getByRole('button', { name: '全局搜索', exact: true })
  await expect(search).toBeVisible()
  const appearance = await search.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      border: style.borderTopColor,
      variant: element.getAttribute('data-button-variant'),
    }
  })
  expect(appearance.variant).toBe('outline')
  expect(appearance.background).not.toBe('rgba(0, 0, 0, 0)')
  expect(appearance.border).toBe('rgba(0, 0, 0, 0)')
  await testInfo.attach('secondary-button-workspace', {
    body: await page.screenshot({ mask: [page.locator('input'), page.locator('[data-slot="avatar"]')] }),
    contentType: 'image/png',
  })
})
