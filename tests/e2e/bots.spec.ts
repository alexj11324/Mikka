import { test, expect, register, conversationPill } from './fixtures'

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
  await page.getByLabel('给 Coordinator 发消息', { exact: true }).fill('登出前的草稿')
  const stored = () => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('mikka:draft:')))
  expect((await stored()).length).toBe(1)
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL(/sign-in/)
  expect(await stored()).toEqual([])
})
