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
  for (const data of [{ prompt: '' }, { prompt: 'a'.repeat(8001) }, { prompt: '你好', apiKey: 'client-key' }, { prompt: '你好', sessionId: 'invalid-session' }]) {
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

function openUIStream(response: string) {
  return [
    { type: 'start' },
    { type: 'text-start', id: 'ui-1' },
    { type: 'text-delta', id: 'ui-1', delta: response },
    { type: 'text-end', id: 'ui-1' },
    { type: 'finish' },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
}

const generatedUI = `root = Stack([heading, tabs, form, note])
heading = TextContent("项目规划建议", "large-heavy")
tabs = Tabs([TabItem("plan", "阶段计划", [table]), TabItem("summary", "交付说明", [description])])
table = Table([Col("阶段", ["需求梳理", "方案验证"]), Col("交付物", ["需求清单", "交互原型"])])
description = TextContent("以上为建议计划，尚未保存到工作区。")
form = Form("refine", buttons, [field])
field = FormControl("项目名称", Input("projectName", "输入项目名称", "text", { required: true }))
buttons = Buttons([Button("填入提问", @ToAssistant("请根据填写的项目名称细化项目计划"), "primary")])
note = TextContent("表单仅填入提问，不会创建项目。")`

test('OpenUI 将模型输出渲染为表格、Tabs 和表单，动作仅填入提问且会话稳定', async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: '有什么可以帮你？' })
  const input = panel.getByRole('textbox', { name: '向 Agent 提问' })
  const sessionIds: string[] = []
  let requests = 0
  await page.route('**/api/agent', route => {
    requests++
    const body = route.request().postDataJSON()
    sessionIds.push(body.sessionId)
    return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'x-vercel-ai-ui-message-stream': 'v1' }, body: openUIStream(generatedUI) })
  })
  await input.fill('请用表格和表单给出项目计划建议')
  await panel.getByRole('button', { name: '发送消息' }).click()
  await expect(panel.getByRole('columnheader', { name: '阶段', exact: true })).toBeVisible()
  await expect(panel.getByRole('cell', { name: '需求梳理', exact: true })).toBeVisible()
  await panel.getByRole('tab', { name: '交付说明' }).click()
  await expect(panel.getByText('以上为建议计划，尚未保存到工作区。', { exact: true })).toBeVisible()
  await panel.getByRole('tab', { name: '阶段计划' }).click()
  await panel.getByRole('textbox', { name: /^项目名称/ }).fill('Orvilo 发布')
  await panel.getByRole('button', { name: '填入提问', exact: true }).click()
  await expect(input).toHaveValue(/Orvilo 发布/)
  await expect(input).toBeFocused()
  expect(requests).toBe(1)
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await expect(panel.getByText(/root = Stack/)).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await panel.getByRole('button', { name: '发送消息' }).click()
  await expect(panel.getByRole('columnheader', { name: '阶段', exact: true })).toBeVisible()
  expect(sessionIds).toHaveLength(2)
  expect(sessionIds[0]).toMatch(/^[0-9a-f-]{36}$/)
  expect(sessionIds[1]).toBe(sessionIds[0])

  await page.route('**/api/agent', route => route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'x-vercel-ai-ui-message-stream': 'v1' }, body: openUIStream('root = Stack([missing])') }))
  await input.fill('测试不完整的模型输出')
  await panel.getByRole('button', { name: '发送消息' }).click()
  await expect(panel.getByRole('alert')).toContainText('界面未能完整生成')
  await expect(input).toHaveValue('测试不完整的模型输出')
})
