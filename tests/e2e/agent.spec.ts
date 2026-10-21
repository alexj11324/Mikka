import { test as apiTest } from '@playwright/test'
import { test, expect, register } from './fixtures'

apiTest('开发预览验收入口不跳转到内部主机', async ({ request, baseURL }) => {
  const response = await request.get('/api/acceptance', { maxRedirects: 0 })
  test.skip(response.status() === 404, '生产环境不提供开发验收入口')
  expect(response.status()).toBe(307)
  expect(response.headers()['location']).toBe('/?acceptance=1')
  expect(response.headers()['cache-control']).toBe('no-store')
  expect(new URL(response.headers()['location'], baseURL).origin).toBe(new URL(baseURL!).origin)
})

test('Agent 直接组合 OpenUI 组件，不嵌入外部网页且保留工作区导航', async ({ page }) => {
  const externalRequests: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).hostname.endsWith('openui.com')) externalRequests.push(request.url())
  })
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: '有什么可以帮你？' })
  await expect(panel).toBeVisible()
  await expect(panel.locator('iframe')).toHaveCount(0)
  await expect(page.getByRole('link', { name: /独立打开/ })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: /重新加载/ })).toHaveCount(0)
  await expect(panel.locator('.openui-card')).toBeVisible()
  const input = panel.getByRole('textbox', { name: '向 Agent 提问' })
  await expect(input).toHaveClass(/openui-textarea/)
  const send = panel.getByRole('button', { name: '发送消息' })
  await expect(send).toBeDisabled()

  await panel.getByRole('button', { name: '拆解项目计划', exact: true }).click()
  await expect(input).toHaveValue('帮我把一个新项目拆解成清晰的阶段、交付物和可执行任务。')
  await expect(input).toBeFocused()
  await expect(send).toBeEnabled()
  await input.fill('原生组件交互测试')
  await input.press('Shift+Enter')
  await expect(input).toHaveValue('原生组件交互测试\n')
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 })
  await expect(panel.getByRole('status')).toHaveCount(0)
  await input.press('Enter')
  await expect(panel.getByRole('status')).toHaveText('尚未连接模型服务，消息未发送。你的输入已保留。')
  await expect(input).toHaveValue('原生组件交互测试\n')
  expect(externalRequests).toEqual([])

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(input).toBeVisible()
  await expect(send).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.setViewportSize({ width: 1159, height: 851 })
  await page.getByRole('button', { name: '我的任务', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我创建的任务', exact: true })).toBeVisible()
  await expect(panel).toHaveCount(0)
})
