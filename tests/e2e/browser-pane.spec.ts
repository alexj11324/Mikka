import { test, expect, register, app } from './fixtures'

// The app-wide browser (Figma 412:8066): the top bar's globe opens it in place
// of the right panel, and a note pinned on a page waits in the chat composer
// as a removable chip.
test('The globe opens the browser in place of the right panel; notes on a page go into the chat composer', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  await register(page)

  const globe = page.getByRole('button', { name: '浏览器', exact: true })
  await expect(globe).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByRole('complementary', { name: '右栏', exact: true })).toBeVisible()

  await globe.click()
  await expect(globe).toHaveAttribute('aria-pressed', 'true')
  const browser = page.getByRole('complementary', { name: '浏览器', exact: true })
  await expect(browser).toBeVisible()
  await expect(page.getByRole('complementary', { name: '右栏', exact: true })).toHaveCount(0)
  const composer = page.getByRole('textbox', { name: '给 Coordinator 发消息' })
  await expect(composer).toBeVisible()

  // A page of the app's own origin can be reached, so an element can be picked.
  const address = browser.getByRole('textbox', { name: '地址', exact: true })
  await address.fill(app('/forgot-password'))
  await address.press('Enter')
  const pick = browser.getByRole('button', { name: '选择元素', exact: true })
  await expect(pick).toBeEnabled()
  await pick.click()
  await expect(pick).toHaveAttribute('aria-pressed', 'true')
  const frame = browser.frameLocator('iframe[title="网页"]')
  await frame.getByRole('button').first().click()
  const note = browser.getByRole('textbox', { name: /^给 .+ 写备注$/ })
  await note.fill('按钮文案改成发送')
  await note.press('Enter')
  const chips = page.locator('[data-slot="browser-note-chip"]')
  await expect(chips).toHaveCount(1)
  await expect(chips.first()).toHaveText('1 · 重置密码 · 发送重置链接 · 按钮文案改成发送')
  await testInfo.attach('element-note', { body: await page.screenshot(), contentType: 'image/png' })

  // Another origin is closed to the app: the same button drags a box, and the note has only the URL.
  // A stand-in for another site, so the test does not depend on the network.
  await page.context().route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>Pricing</h1>' }))
  await address.fill('example.com/pricing')
  await address.press('Enter')
  await expect(address).toHaveValue('https://example.com/pricing')
  await expect(browser.getByRole('button', { name: '框选区域' })).toHaveCount(0)
  await expect(browser.getByRole('button', { name: '在新标签页打开' })).toHaveCount(0)
  await pick.click()
  await expect(pick).toHaveAttribute('aria-pressed', 'true')
  const stage = browser.locator('[data-slot="browser-stage"]')
  const box = (await stage.boundingBox())!
  await page.mouse.move(box.x + 40, box.y + 40)
  await page.mouse.down()
  await page.mouse.move(box.x + 240, box.y + 160, { steps: 4 })
  await page.mouse.up()
  await browser.getByRole('textbox', { name: '给 example.com/pricing 写备注', exact: true }).fill('价格不对')
  await browser.getByRole('button', { name: '放进对话', exact: true }).click()
  await expect(chips).toHaveCount(2)
  await expect(chips.nth(1)).toHaveText('2 · example.com/pricing · 价格不对')
  await testInfo.attach('region-note', { body: await page.screenshot(), contentType: 'image/png' })

  await page.getByRole('button', { name: '移除备注 1', exact: true }).click()
  await expect(chips).toHaveCount(1)

  await browser.getByRole('button', { name: '关闭浏览器', exact: true }).click()
  await expect(globe).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByRole('complementary', { name: '右栏', exact: true })).toBeVisible()
})
