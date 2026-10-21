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
  await expect(panel.locator('[data-slot="frame"]')).toHaveCount(0)
  await expect(panel.locator('form')).toBeVisible()
  await expect(panel.locator('[data-slot="empty"]')).toBeVisible()
  await expect(panel.locator('[data-slot="message-scroller"]')).toBeVisible()
  const input = panel.getByRole('textbox', { name: '向 Agent 提问' })
  await expect(input).toHaveAttribute('maxlength', '8000')
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
  await expect(panel.getByRole('group', { name: '你的问题', exact: true })).toContainText('原生组件交互测试')
  await panel.getByRole('button', { name: '新问题', exact: true }).click()
  await expect(input).toHaveValue('')
  await expect(send).toBeDisabled()
  await expect(panel.getByRole('group', { name: 'Agent 回复', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '拆解项目计划', exact: true })).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(input).toBeVisible()
  await expect(send).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.setViewportSize({ width: 1159, height: 851 })
  await page.getByRole('button', { name: '我的任务', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我创建的任务', exact: true })).toBeVisible()
  await expect(panel).toHaveCount(0)
})

for (const stage of ['headers', 'body'] as const) {
  test(`停止生成在 ${stage} 阶段取消请求且不重新提交`, async ({ page }) => {
    await register(page)
    await page.getByRole('button', { name: 'Agent', exact: true }).click()
    const panel = page.getByRole('region', { name: '有什么可以帮你？' })
    const input = panel.getByRole('textbox', { name: '向 Agent 提问' })
    await page.evaluate(stage => {
      const state = { requests: 0, aborted: false }
      Object.assign(window, { agentCancellationTest: state })
      const original = window.fetch.bind(window)
      window.fetch = async (url, options) => {
        if (!String(url).endsWith('/api/agent')) return original(url, options)
        state.requests++
        options?.signal?.addEventListener('abort', () => { state.aborted = true }, { once: true })
        if (stage === 'headers') return new Promise<Response>(() => {})
        return new Response(new ReadableStream({
          start(controller) {
            const events = [{ type: 'start' }, { type: 'text-start', id: 'partial' }, { type: 'text-delta', id: 'partial', delta: 'root = TextContent("取消前的部分回复")' }]
            controller.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')))
          },
        }), { headers: { 'Content-Type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } })
      }
    }, stage)
    await input.fill('停止后保留的提问')
    await panel.getByRole('button', { name: '发送消息' }).click()
    if (stage === 'body') await expect(panel.getByText('取消前的部分回复', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: '停止生成' }).click()
    await expect(panel.getByRole('button', { name: '发送消息' })).toBeEnabled()
    await expect(input).toHaveValue('停止后保留的提问')
    await expect(input).toBeEditable()
    await expect(panel.getByRole('alert')).toHaveCount(0)
    expect(await page.evaluate(() => Reflect.get(window, 'agentCancellationTest'))).toEqual({ requests: 1, aborted: true })
    await panel.getByRole('button', { name: '发送消息' }).click()
    await panel.getByRole('button', { name: '停止生成' }).click()
    await expect(panel.getByRole('button', { name: '发送消息' })).toBeEnabled()
    expect(await page.evaluate(() => Reflect.get(window, 'agentCancellationTest').requests)).toBe(2)
    await panel.getByRole('button', { name: '新问题', exact: true }).click()
    await expect(input).toHaveValue('')
  })
}

function openUIStream(response: string) {
  return [
    { type: 'start' },
    { type: 'text-start', id: 'ui-1' },
    { type: 'text-delta', id: 'ui-1', delta: response },
    { type: 'text-end', id: 'ui-1' },
    { type: 'finish' },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
}

test('beUI 注册组件展示用户数字且动效按钮只填入提问', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: '有什么可以帮你？' })
  const input = panel.getByRole('textbox', { name: '向 Agent 提问' })
  let requests = 0
  await page.route('**/api/agent', route => {
    requests++
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'x-vercel-ai-ui-message-stream': 'v1' },
      body: openUIStream(`root = Stack([badge, statistic, button])
badge = BeBadge("用户提供的状态", "info")
statistic = BeStat("本周完成任务", 12.5, "项", 1)
button = BeButton("继续细化", "请根据本周完成12.5项任务的数据给出改进建议", "outline")`),
    })
  })
  await input.fill('本周完成12.5项任务，请展示我提供的数据')
  await panel.getByRole('button', { name: '发送消息' }).click()
  await expect(panel.locator('[data-badge-label]')).toHaveText('用户提供的状态')
  await expect(panel.getByText('12.5项', { exact: true }).first()).toBeVisible()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await panel.getByRole('button', { name: '继续细化', exact: true }).click()
  await expect(input).toHaveValue('请根据本周完成12.5项任务的数据给出改进建议')
  await expect(input).toBeFocused()
  expect(requests).toBe(1)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('beUI 功能组展示回复与计划，审批和多步回答直接继续且不覆盖草稿', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: '有什么可以帮你？' })
  const input = panel.getByRole('textbox', { name: '向 Agent 提问' })
  const submissions: { prompt: string; sessionId: string }[] = []
  await page.route('**/api/agent', route => {
    submissions.push(route.request().postDataJSON())
    if (submissions.length > 1) return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'x-vercel-ai-ui-message-stream': 'v1' }, body: openUIStream(`root = TextContent("已根据第 ${submissions.length} 次提交继续提供建议。")`) })
    return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'x-vercel-ai-ui-message-stream': 'v1' }, body: openUIStream(`root = Stack([response, tasks, approval, questions, icon])
response = BeResponse([TextContent("按功能组合的回复内容")])
tasks = BeTodoList("建议任务计划", [{ id: "one", title: "整理需求", status: "completed", progress: 100 }], "suggestion")
approval = BeApproval("确认需求方案", "先整理需求再提供设计建议。", "项目是 Orvilo，当前正在讨论首版范围。")
questions = BeQuestions("项目是 Orvilo，需要明确首版范围和检查要求。", [{ id: "scope", title: "首版范围？", options: [{ value: "small", label: "精简首版" }, { value: "large", label: "完整版本" }] }, { id: "checks", title: "需要哪些检查？", options: [{ value: "types", label: "类型检查" }, { value: "keyboard", label: "键盘交互" }], multiple: true, allowCustom: true }])
icon = AgentIcon("question", "等待你的意见")`) })
  })
  await input.fill('请给出项目建议和澄清问题')
  await panel.getByRole('button', { name: '发送消息' }).click()
  await expect(panel.getByText('按功能组合的回复内容', { exact: true })).toBeVisible()
  const tasks = panel.getByRole('region', { name: 'Agent 任务列表', exact: true })
  await expect(tasks).toContainText('待开始')
  await expect(tasks).toContainText('已完成 0 项')
  await expect(panel.getByText('等待你的意见', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: '发送消息' })).toBeEnabled()
  await input.fill('未发送的独立草稿')
  await panel.getByRole('button', { name: '同意并继续', exact: true }).click()
  await expect(panel.getByText('已根据第 2 次提交继续提供建议。', { exact: true })).toBeVisible()
  await expect(input).toHaveValue('未发送的独立草稿')
  await expect(panel.getByText('同意这个建议方案，已提交给 Agent；未执行工作区操作。', { exact: true })).toBeVisible()
  expect(submissions).toHaveLength(2)
  expect(submissions[1].prompt).toContain('项目是 Orvilo')
  expect(submissions[1].prompt).toContain('同意这个建议方案')
  await expect(panel.getByRole('button', { name: '同意并继续', exact: true })).toHaveCount(0)
  await panel.getByRole('radio', { name: '精简首版' }).check()
  await panel.getByRole('button', { name: '下一题', exact: true }).click()
  await expect(panel.getByRole('heading', { name: '需要哪些检查？', exact: true })).toBeVisible()
  await panel.getByRole('checkbox', { name: '类型检查' }).check()
  await panel.getByRole('checkbox', { name: '键盘交互' }).check()
  await panel.getByPlaceholder('补充其他回答…').fill('还需要移动端验收')
  await panel.getByRole('button', { name: '提交回答并继续', exact: true }).click()
  await expect(panel.getByText('已根据第 3 次提交继续提供建议。', { exact: true })).toBeVisible()
  expect(submissions).toHaveLength(3)
  expect(submissions[2].prompt).toContain('首版范围？：精简首版')
  expect(submissions[2].prompt).toContain('类型检查；键盘交互；还需要移动端验收')
  expect(submissions.every(body => body.sessionId === submissions[0].sessionId)).toBe(true)
  await expect(input).toHaveValue('未发送的独立草稿')
  await expect(panel.getByRole('group', { name: 'Agent 回复', exact: true })).toHaveCount(3)
  await expect(panel.getByRole('button', { name: '提交回答并继续', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await panel.getByRole('button', { name: '新问题', exact: true }).click()
  await expect(panel.getByRole('group', { name: 'Agent 回复', exact: true })).toHaveCount(0)
  await expect(input).toHaveValue('')
})

test('beUI 内联回答失败与停止后保留选择，可在原卡片重试且不重复提交', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: '有什么可以帮你？' })
  const input = panel.getByRole('textbox', { name: '向 Agent 提问' })
  const submissions: { prompt: string; sessionId: string }[] = []
  await page.route('**/api/agent', route => {
    submissions.push(route.request().postDataJSON())
    const response = submissions.length === 1
      ? openUIStream('root = BeQuestions("Orvilo 首版建议", [{ id: "scope", title: "选择验证范围？", options: [{ value: "types", label: "类型检查" }, { value: "keyboard", label: "键盘交互" }], multiple: true, allowCustom: true }])')
      : submissions.length === 2
        ? 'data: {"type":"error","errorText":"测试：请重试本次回答。"}\n\ndata: [DONE]\n\n'
        : openUIStream('root = TextContent("已按保留的答案继续。")')
    return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'x-vercel-ai-ui-message-stream': 'v1' }, body: response })
  })
  await input.fill('请帮我明确验证范围')
  await panel.getByRole('button', { name: '发送消息' }).click()
  await panel.getByRole('checkbox', { name: '类型检查', exact: true }).check()
  await panel.getByPlaceholder('补充其他回答…').fill('移动端也检查')
  await input.fill('独立草稿不应被覆盖')
  const submit = panel.getByRole('button', { name: '提交回答并继续', exact: true })
  await submit.click()
  const retryError = panel.getByText('本次继续未完成，选择和回答已保留，可以在此重试。', { exact: true })
  await expect(retryError).toBeVisible()
  await expect(panel.getByRole('checkbox', { name: '类型检查', exact: true })).toBeChecked()
  await expect(panel.getByPlaceholder('补充其他回答…')).toHaveValue('移动端也检查')
  await expect(input).toHaveValue('独立草稿不应被覆盖')
  expect(submissions).toHaveLength(2)

  await page.evaluate(() => {
    const original = window.fetch.bind(window)
    const state = { requests: 0, aborted: false }
    Object.assign(window, { inlineCancellationTest: state })
    window.fetch = async (url, options) => {
      if (!String(url).endsWith('/api/agent') || state.requests > 0) return original(url, options)
      state.requests++
      options?.signal?.addEventListener('abort', () => { state.aborted = true }, { once: true })
      return new Promise<Response>(() => {})
    }
  })
  await submit.click()
  await expect(submit).toBeDisabled()
  await panel.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(retryError).toBeVisible()
  await expect(submit).toBeEnabled()
  await expect(panel.getByRole('checkbox', { name: '类型检查', exact: true })).toBeChecked()
  await expect(panel.getByPlaceholder('补充其他回答…')).toHaveValue('移动端也检查')
  expect(await page.evaluate(() => Reflect.get(window, 'inlineCancellationTest'))).toEqual({ requests: 1, aborted: true })
  await submit.click()
  await expect(panel.getByText('已按保留的答案继续。', { exact: true })).toBeVisible()
  await expect(retryError).toHaveCount(0)
  await expect(submit).toHaveCount(0)
  await expect(input).toHaveValue('独立草稿不应被覆盖')
  expect(submissions).toHaveLength(3)
  expect(submissions[2]).toEqual(submissions[1])
})

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

  const localUI = `root = Stack([card, frame, progress, accordion, tabs, button])
card = ShadcnCard("本地组件验证", [badge, table], "这些组件来自项目已有源码。")
badge = ShadcnBadge("建议", "secondary")
table = ShadcnTable(["事项", "状态"], [["注册本地组件", "可使用"]])
frame = ReuiFrame("REUI 面板", [reuiBadge, reuiAlert])
reuiBadge = ReuiBadge("已注册", "info-light")
reuiAlert = ReuiAlert("使用说明", "仅展示建议，不会保存工作区数据。", "info")
progress = ShadcnProgress("用户提供的完成率", 40)
accordion = ShadcnAccordion([{ title: "本地折叠说明", content: "没有自动安装任何未注册组件。" }])
tabs = ShadcnTabs([{ title: "方案甲", children: [TextContent("本地方案甲内容")] }, { title: "方案乙", children: [ShadcnAlert("本地提示", "本地方案乙内容")] }])
button = ShadcnButton("继续细化", "请细化本地组件注册方案", "outline")`
  await page.route('**/api/agent', route => route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'x-vercel-ai-ui-message-stream': 'v1' }, body: openUIStream(localUI) }))
  await input.fill('验证本地 shadcn 和 REUI 组件')
  await panel.getByRole('button', { name: '发送消息' }).click()
  await expect(panel.locator('[data-slot="card-title"]')).toContainText('本地组件验证')
  await expect(panel.getByRole('cell', { name: '注册本地组件', exact: true })).toBeVisible()
  await expect(panel.locator('[data-slot="frame-panel-title"]')).toContainText('REUI 面板')
  await expect(panel.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
  await panel.getByRole('button', { name: '本地折叠说明', exact: true }).click()
  await expect(panel.getByText('没有自动安装任何未注册组件。', { exact: true })).toBeVisible()
  await panel.getByRole('tab', { name: '方案乙', exact: true }).click()
  await expect(panel.getByText('本地方案乙内容', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '继续细化', exact: true }).click()
  await expect(input).toHaveValue(/请细化本地组件注册方案/)
  await expect(panel.getByRole('alert')).toHaveCount(0)
  expect(requests).toBe(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await page.route('**/api/agent', route => route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'x-vercel-ai-ui-message-stream': 'v1' }, body: openUIStream('root = Stack([missing])') }))
  await input.fill('测试不完整的模型输出')
  await panel.getByRole('button', { name: '发送消息' }).click()
  await expect(panel.getByRole('alert')).toContainText('界面未能完整生成')
  await expect(input).toHaveValue('测试不完整的模型输出')
})
