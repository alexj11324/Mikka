import { test, expect, register, app } from './fixtures'

test('聊天历史未返回时壳子已可导航，恢复后显示真实会话', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let requested = false
  await page.route('**/api/agent/sessions', async route => {
    requested = true
    await pending
    await route.continue()
  })
  try {
    await register(page)
    await expect.poll(() => requested).toBe(true)
    await expect(page).not.toHaveURL(/section=agent/)
    await expect(page.getByRole('button', { name: '工作区菜单', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Agent', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Agent 对话工作区', exact: true })).toHaveAttribute('aria-busy', 'true')
    await page.getByRole('button', { name: '我的任务', exact: true }).click()
    await expect(page).not.toHaveURL(/section=agent/)
    await page.getByRole('button', { name: 'Agent', exact: true }).click()
    release()
    await expect(page.getByRole('textbox', { name: '向 Agent 提问', exact: true })).toBeVisible()
  } finally {
    release()
  }
})

test('任务与项目请求未返回时聊天可独立加载', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await register(page)
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let blocked = false
  await page.route('**/*', async route => {
    if (route.request().method() === 'POST' && route.request().headers()['next-action']) {
      blocked = true
      await pending
    }
    await route.continue()
  })
  try {
    await page.goto(app('/?section=agent'), { waitUntil: 'domcontentloaded' })
    await expect.poll(() => blocked).toBe(true)
    await expect(page.getByRole('textbox', { name: '向 Agent 提问', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '工作区菜单', exact: true })).toBeVisible()
  } finally {
    release()
  }
})
