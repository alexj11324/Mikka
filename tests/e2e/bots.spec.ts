import { test, expect, register, conversationPill, hydrated } from './fixtures'

// The left column is a list of bots; the Coordinator is one of them. Every bot
// chats on the Coordinator harness, in its own conversation. No model runs in
// e2e, so a sent message stays pending in that bot's inbox, which is enough to
// show where it went.
test('新建 Bot 进入左侧列表，打开它自己的对话，消息不进 Coordinator', async ({ page }) => {
  await register(page)
  const bots = page.getByRole('list', { name: 'Bot', exact: true })
  await expect(bots.getByRole('button', { name: 'Coordinator', exact: true })).toBeVisible()

  await page.getByRole('button', { name: '新建 Bot', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: '新建 Bot' })
  await dialog.getByLabel('名字', { exact: true }).fill('写作助手')
  await dialog.getByRole('button', { name: '爱心', exact: true }).click()
  await dialog.getByRole('button', { name: '绿色', exact: true }).click()
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog).toBeHidden()

  // The new bot's chat opens at once, under its own name, and survives a reload.
  await expect(conversationPill(page)).toHaveText('写作助手')
  await expect(page).toHaveURL(/[?&]bot=[0-9a-f-]{36}/)
  const row = bots.getByRole('button', { name: '写作助手', exact: true })
  await expect(row).toBeVisible()
  // Its bloub wears the shape and colour picked in the dialog.
  await expect(row.locator('[data-slot="bot-avatar"]')).toHaveAttribute('data-shape', 'coeur')
  await expect(row.locator('[data-slot="bot-avatar"]')).toHaveAttribute('data-color', 'vert')

  const composer = page.getByLabel('给 写作助手 发消息', { exact: true })
  await composer.fill('帮我起草一份周报')
  await composer.press('Enter')
  const botChat = page.getByRole('region', { name: '与 写作助手 的对话', exact: true })
  await expect(botChat.getByText('帮我起草一份周报', { exact: true })).toBeVisible()
  // With no Coordinator to answer, the unanswered message reads as a failed turn, not silence.
  await expect(page.getByRole('alert').filter({ hasText: '写作助手 暂时不可用' })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('bot-chat.png'), fullPage: false })

  await page.reload()
  await expect(conversationPill(page)).toHaveText('写作助手')
  await expect(botChat.getByText('帮我起草一份周报', { exact: true })).toBeVisible()

  await bots.getByRole('button', { name: 'Coordinator', exact: true }).click()
  await expect(conversationPill(page)).toHaveText('Coordinator')
  await expect(page).not.toHaveURL(/[?&]bot=/)
  await expect(page.getByLabel('给 Coordinator 发消息', { exact: true })).toBeVisible()
  await expect(page.getByText('帮我起草一份周报', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('coordinator-chat.png'), fullPage: false })
})

// A02: an unsent draft belongs to the bot it was typed for. Switching bots
// must not move it into another composer or drop it.
test('切换 Bot 时各自保留未发送的草稿', async ({ page }) => {
  await register(page)
  const bots = page.getByRole('list', { name: 'Bot', exact: true })
  await page.getByRole('button', { name: '新建 Bot', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: '新建 Bot' })
  await dialog.getByLabel('名字', { exact: true }).fill('草稿 Bot')
  await dialog.getByRole('button', { name: '爱心', exact: true }).click()
  await dialog.getByRole('button', { name: '绿色', exact: true }).click()
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog).toBeHidden()

  await page.getByLabel('给 草稿 Bot 发消息', { exact: true }).fill('未发送的草稿')
  await bots.getByRole('button', { name: 'Coordinator', exact: true }).click()
  await expect(page.getByLabel('给 Coordinator 发消息', { exact: true })).toHaveValue('')
  await bots.getByRole('button', { name: '草稿 Bot', exact: true }).click()
  await expect(page.getByLabel('给 草稿 Bot 发消息', { exact: true })).toHaveValue('未发送的草稿')
})

// A09: pressing send twice on a slow network must not create two messages.
test('连续按下发送只提交一次', async ({ page }) => {
  await register(page)
  await page.route('**/*', async route => {
    const request = route.request()
    if (request.method() === 'POST' && request.headers()['next-action']) {
      await new Promise(resolve => setTimeout(resolve, 1200))
    }
    return route.fallback()
  })
  const composer = page.getByLabel('给 Coordinator 发消息', { exact: true })
  await hydrated(composer)
  await composer.fill('只提交一次')
  await composer.press('Enter')
  await composer.press('Enter')
  await expect(page.getByText('只提交一次', { exact: true })).toHaveCount(1)
  await page.waitForTimeout(1500)
  await expect(page.getByText('只提交一次', { exact: true })).toHaveCount(1)
})

// A08: a send that fails must keep the draft and say it failed, then retry.
test('发送失败后草稿仍保留，恢复后可再发', async ({ page }) => {
  await register(page)
  const composer = page.getByLabel('给 Coordinator 发消息', { exact: true })
  await hydrated(composer)
  await composer.fill('发送失败时保留')
  const failPost = async (route: import('@playwright/test').Route) => {
    const request = route.request()
    if (request.method() === 'POST' && request.headers()['next-action']) return route.fulfill({ status: 200, contentType: 'text/x-component', body: '' })
    return route.fallback()
  }
  await page.route('**/*', failPost)
  await composer.press('Enter')
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(composer).toHaveValue('发送失败时保留')
  await page.unroute('**/*', failPost)
  await composer.press('Enter')
  await expect(page.getByText('发送失败时保留', { exact: true })).toBeVisible()
})

// A28: the limit is visible near the edge, and over-long input is truncated
// without throwing away what the person already typed.
test('接近长度上限时显示计数，超长输入被截断但不清空', async ({ page }) => {
  await register(page)
  const composer = page.getByLabel('给 Coordinator 发消息', { exact: true })
  await hydrated(composer)
  await composer.fill('字'.repeat(9600))
  await expect(page.getByText('9600 / 10000')).toBeVisible()
  await composer.fill('字'.repeat(10500))
  await expect(page.getByText('10000 / 10000')).toBeVisible()
  expect((await composer.inputValue()).length).toBe(10000)
})

// Drafts must not outlive the session: a later account on this tab must not
// find them.
test('登出会清除本标签页里未发送的草稿', async ({ page }) => {
  await register(page)
  const composer = page.getByLabel('给 Coordinator 发消息', { exact: true })
  await hydrated(composer)
  await composer.fill('登出前的草稿')
  const stored = () => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('mikka:draft:')))
  expect((await stored()).length).toBe(1)
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL(/sign-in/)
  expect(await stored()).toEqual([])
})

async function newBot(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('button', { name: '新建 Bot', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: '新建 Bot' })
  await dialog.getByLabel('名字', { exact: true }).fill(name)
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(conversationPill(page)).toHaveText(name)
}

// The right panel's name edits in place: Enter or leaving the field saves, Esc
// cancels, and a name that does not save says why and leaves the old one.
test('右栏点击 Bot 名字直接改名，左侧列表和标题一起更新', async ({ page }) => {
  await register(page)
  await newBot(page, '另一个 Bot')
  await newBot(page, '改名前')
  const panel = page.getByRole('complementary', { name: '右栏', exact: true })
  const bots = page.getByRole('list', { name: 'Bot', exact: true })
  const nameButton = panel.getByRole('button', { name: '改名前', exact: true })
  const field = panel.getByLabel('名字', { exact: true })

  // Click opens the field with the whole name selected, so typing replaces it.
  await nameButton.click()
  await expect(field).toBeFocused()
  expect(await field.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, 3])
  await field.pressSequentially('周报助手')
  await field.press('Enter')
  await expect(field).toBeHidden()
  await expect(panel.getByRole('heading', { name: '周报助手', exact: true })).toBeVisible()
  await expect(conversationPill(page)).toHaveText('周报助手')
  await expect(bots.getByRole('button', { name: '周报助手', exact: true })).toBeVisible()
  await expect(bots.getByRole('button', { name: '改名前', exact: true })).toHaveCount(0)

  // Esc cancels; the keyboard can open it again with Enter.
  const renamed = panel.getByRole('button', { name: '周报助手', exact: true })
  await expect(renamed).toBeFocused()
  await renamed.press('Enter')
  await field.fill('不保存')
  await field.press('Escape')
  await expect(field).toBeHidden()
  await expect(panel.getByRole('heading', { name: '周报助手', exact: true })).toBeVisible()

  // Empty and over-long names stay in the field with the reason.
  await renamed.click()
  await field.fill('   ')
  await field.press('Enter')
  await expect(panel.getByRole('alert')).toHaveText('名字不能为空')
  await field.fill('长'.repeat(61))
  await field.press('Enter')
  await expect(panel.getByRole('alert')).toHaveText('名字最多 60 个字')
  await expect(field).toHaveAttribute('aria-invalid', 'true')

  // Another bot's name does not save: the old name comes back everywhere.
  await field.fill('另一个 Bot')
  await field.press('Enter')
  await expect(panel.getByRole('alert')).toHaveText('已有同名 Bot，请换一个名字。')
  await expect(field).toHaveValue('另一个 Bot')
  await expect(conversationPill(page)).toHaveText('周报助手')
  await expect(bots.getByRole('button', { name: '周报助手', exact: true })).toBeVisible()

  // Leaving the field saves.
  await field.fill('日报助手')
  await page.getByLabel('给 周报助手 发消息', { exact: true }).click()
  await expect(conversationPill(page)).toHaveText('日报助手')

  await page.reload()
  await expect(conversationPill(page)).toHaveText('日报助手')
  await expect(panel.getByRole('heading', { name: '日报助手', exact: true })).toBeVisible()
  await expect(bots.getByRole('button', { name: '日报助手', exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('bot-renamed.png'), fullPage: false })
})

// The big avatar opens the 新建 Bot picker; each pick saves and the left row follows.
test('右栏点击 Bot 头像更换形状和颜色', async ({ page }) => {
  await register(page)
  await newBot(page, '换头像')
  const panel = page.getByRole('complementary', { name: '右栏', exact: true })
  const row = page.getByRole('list', { name: 'Bot', exact: true }).getByRole('button', { name: '换头像', exact: true })
  const avatar = panel.getByRole('button', { name: '更换 换头像 的头像', exact: true })
  await avatar.click()
  const picker = page.getByRole('dialog', { name: '更换 换头像 的头像', exact: true })
  await picker.getByRole('button', { name: '六边形', exact: true }).click()
  await picker.getByRole('button', { name: '红色', exact: true }).click()
  await expect(avatar.locator('[data-slot="bot-avatar"]')).toHaveAttribute('data-shape', 'hexagone')
  await expect(avatar.locator('[data-slot="bot-avatar"]')).toHaveAttribute('data-color', 'rouge')
  await expect(row.locator('[data-slot="bot-avatar"]')).toHaveAttribute('data-shape', 'hexagone')
  await page.screenshot({ path: test.info().outputPath('bot-avatar-picker.png'), fullPage: false })
  await page.keyboard.press('Escape')
  await expect(picker).toBeHidden()

  await page.reload()
  await expect(row.locator('[data-slot="bot-avatar"]')).toHaveAttribute('data-shape', 'hexagone')
  await expect(row.locator('[data-slot="bot-avatar"]')).toHaveAttribute('data-color', 'rouge')
})

// With reduced motion the preview is a still blob. It used to keep drawing the
// shape picked before (the hexagon showed the triangle): a still bloub is
// sampled at time 0 while its morph starts at the current clock.
test('新建 Bot 预览跟随所选形状和颜色（减少动态效果时也是）', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await register(page)
  await page.getByRole('button', { name: '新建 Bot', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: '新建 Bot' })
  const preview = dialog.locator('[data-slot="bot-avatar"]').first()
  // Shape outlines are drawn in bloub's own coordinates, so a still tile and the still preview of one shape share the path.
  const outline = (avatar: import('@playwright/test').Locator) => avatar.locator('path').first().getAttribute('d')
  for (const shape of ['三角', '六边形', '爱心']) {
    const tile = dialog.getByRole('button', { name: shape, exact: true })
    await tile.click()
    await expect.poll(() => outline(preview)).toBe(await outline(tile.locator('[data-slot="bot-avatar"]')))
  }
  await dialog.getByRole('button', { name: '红色', exact: true }).click()
  await expect(preview).toHaveAttribute('data-color', 'rouge')
  await expect.poll(() => preview.locator('path').first().getAttribute('fill')).toBe(await dialog.getByRole('button', { name: '爱心', exact: true }).locator('path').first().getAttribute('fill'))
})
