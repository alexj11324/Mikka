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

apiTest('Agent 接口拒绝未登录请求与跨站请求', async ({ request }) => {
  const unauthenticated = await request.post('/api/agent', { data: { prompt: '你好' } })
  expect(unauthenticated.status()).toBe(401)
  const crossSite = await request.post('/api/agent', { headers: { 'sec-fetch-site': 'cross-site' }, data: { prompt: '你好' } })
  expect(crossSite.status()).toBe(403)
})

test('Agent 接口验证输入且不接受客户端密钥', async ({ page }) => {
  await register(page)
  for (const data of [{ prompt: '' }, { prompt: 'a'.repeat(8001) }, { prompt: '你好', apiKey: 'client-key' }]) {
    const response = await page.request.post('/api/agent', { data })
    expect(response.status()).toBe(400)
  }
  const malformed = await page.request.post('/api/agent', { headers: { 'Content-Type': 'application/json' }, data: '{' })
  expect(malformed.status()).toBe(400)
  const oversized = await page.request.post('/api/agent', { data: { prompt: 'a'.repeat(40001) } })
  expect(oversized.status()).toBe(413)
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
  let submittedPrompt = ''
  await page.route('**/api/agent', async route => {
    submittedPrompt = route.request().postDataJSON().prompt
    await route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'x-vercel-ai-ui-message-stream': 'v1' }, body: 'data: {"type":"error","errorText":"测试：模型暂时不可用。"}\n\ndata: [DONE]\n\n' })
  })
  await input.press('Enter')
  await expect(panel.getByRole('alert')).toContainText('测试：模型暂时不可用。')
  await expect(input).toHaveValue('原生组件交互测试\n')
  expect(submittedPrompt).toBe('原生组件交互测试')
  await page.route('**/api/agent', route => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    headers: { 'x-vercel-ai-ui-message-stream': 'v1' },
    body: 'data: {"type":"start"}\n\ndata: {"type":"text-start","id":"text-1"}\n\ndata: {"type":"text-delta","id":"text-1","delta":"已收到你的问题。"}\n\ndata: {"type":"text-end","id":"text-1"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n',
  }))
  await send.click()
  await expect(panel.getByText('已收到你的问题。', { exact: true })).toBeVisible()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await expect(send).toBeEnabled()
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
