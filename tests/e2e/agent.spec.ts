import { test as apiTest } from '@playwright/test'
import { test, expect, register, app } from './fixtures'

apiTest('开发预览验收入口不跳转到内部主机', async ({ request, baseURL }) => {
  const response = await request.get(app('/api/acceptance'), { maxRedirects: 0 })
  test.skip(response.status() === 404, '生产环境不提供开发验收入口')
  expect(response.status()).toBe(307)
  expect(response.headers()['location']).toBe(app('/?acceptance=1'))
  expect(response.headers()['cache-control']).toBe('no-store')
  expect(new URL(response.headers()['location'], baseURL).origin).toBe(new URL(baseURL!).origin)
})

apiTest('Agent 接口拒绝未登录请求与跨站请求', async ({ request }) => {
  const unauthenticated = await request.post(app('/api/agent'), { data: { prompt: '你好' } })
  expect(unauthenticated.status()).toBe(401)
  const crossSite = await request.post(app('/api/agent'), { headers: { 'sec-fetch-site': 'cross-site' }, data: { prompt: '你好' } })
  expect(crossSite.status()).toBe(403)
})

test('Agent 接口验证输入且不接受客户端密钥', async ({ page }) => {
  await register(page)
  for (const data of [{ prompt: '' }, { prompt: 'a'.repeat(8001) }, { prompt: '你好', apiKey: 'client-key' }, { prompt: '你好', sessionId: 'invalid-session' }]) {
    const response = await page.request.post(app('/api/agent'), { data })
    expect(response.status()).toBe(400)
  }
  const malformed = await page.request.post(app('/api/agent'), { headers: { 'Content-Type': 'application/json' }, data: '{' })
  expect(malformed.status()).toBe(400)
  const oversized = await page.request.post(app('/api/agent'), { data: { prompt: 'a'.repeat(40001) } })
  expect(oversized.status()).toBe(413)
})

test('Agent 直接组合 OpenUI 组件，不嵌入外部网页且保留工作区导航', async ({ page }) => {
  const externalRequests: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).hostname.endsWith('openui.com')) externalRequests.push(request.url())
  })
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Agent 对话工作区' })
  await expect(panel).toBeVisible()
  await expect(panel.locator('iframe')).toHaveCount(0)
  await expect(page.getByRole('link', { name: /独立打开/ })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: /重新加载/ })).toHaveCount(0)
  await expect(panel.locator('[data-slot="frame"]')).toHaveCount(0)
  await expect(panel.locator('form')).toBeVisible()
  await expect(panel.getByText('今天想完成什么？', { exact: true })).toHaveCount(0)
  await expect(panel.getByRole('region', { name: '推荐建议' })).toBeVisible()
  await expect(panel.locator('[data-slot="message-scroller"]')).toHaveCount(0)
  await expect(page.locator('main')).toHaveCount(1)
  await expect(panel.locator('header')).toHaveCount(1)
  await expect(page.locator('[data-openui-devtools-auto-mount]')).toHaveCount(0)
  const input = panel.getByRole('textbox', { name: '向 Agent 提问' })
  await expect(input).toHaveAttribute('maxlength', '8000')
  const send = panel.getByRole('button', { name: '发送消息' })
  await expect(send).toBeDisabled()

  await panel.getByRole('button', { name: '拆解项目计划 把想法拆成清晰的阶段和可执行任务', exact: true }).click()
  await expect(input).toHaveValue('帮我把一个新项目拆解成清晰的阶段、交付物和可执行任务。')
  await expect(input).toBeFocused()
  await panel.getByRole('button', { name: '添加到提问', exact: true }).click()
  await page.getByRole('dialog', { name: '添加到提问', exact: true }).getByRole('button', { name: '拆解项目计划', exact: true }).click()
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
  await expect(panel.getByRole('region', { name: '推荐建议' })).toHaveCount(0)
  await expect(panel.locator('footer form')).toBeVisible()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await expect(send).toBeDisabled()
  expect(externalRequests).toEqual([])
  await expect(panel.getByRole('article', { name: '你的问题', exact: true })).toContainText('原生组件交互测试')
  await panel.getByRole('button', { name: '新任务', exact: true }).click()
  await expect(input).toHaveValue('')
  await expect(send).toBeDisabled()
  await expect(panel.getByRole('article', { name: 'Agent 回复', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('region', { name: '推荐建议' })).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(input).toBeVisible()
  await expect(send).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.setViewportSize({ width: 1159, height: 851 })
  await page.getByRole('button', { name: '我的任务', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我创建的任务', exact: true })).toBeVisible()
  await expect(panel).toHaveCount(0)
})

test('Agent 输入完整显示单行文字，超过四行才显示自定义滚动条', async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Agent 对话工作区' })
  const input = panel.getByRole('textbox', { name: '向 Agent 提问' })
  const scroller = panel.locator('form [data-slot="scroll-area"]')
  const viewport = scroller.locator('[data-slot="scroll-area-viewport"]')

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 })
    for (const value of ['', '国 Agj 一行']) {
      await input.fill(value)
      await expect.poll(() => input.evaluate(element => element.scrollHeight - element.clientHeight)).toBe(0)
      await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight)).toBe(0)
      await expect(scroller).not.toHaveAttribute('data-has-overflow-y')
      expect(await input.evaluate(element => getComputedStyle(element).overflowY)).toBe('hidden')
    }
    await input.fill(Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行：文字完整显示`).join('\n'))
    await expect(scroller).toHaveAttribute('data-has-overflow-y', '')
    await expect.poll(() => viewport.evaluate(element => element.clientHeight)).toBe(108)
    await expect.poll(() => input.evaluate(element => element.scrollHeight - element.clientHeight)).toBe(0)
    await input.press('Control+Home')
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0)
    await input.press('Control+End')
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await expect(panel.getByRole('button', { name: '发送消息' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await input.fill('')
  await expect(scroller).not.toHaveAttribute('data-has-overflow-y')
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0)
})

for (const stage of ['headers', 'body'] as const) {
  test(`停止生成在 ${stage} 阶段取消请求且不重新提交`, async ({ page }) => {
    await register(page)
    await page.getByRole('button', { name: 'Agent', exact: true }).click()
    const panel = page.getByRole('region', { name: 'Agent 对话工作区' })
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
            const events = [{ type: 'start' }, { type: 'text-start', id: 'partial' }, { type: 'text-delta', id: 'partial', delta: 'root = Stack([intro, missing])\nintro = TextContent("取消前的部分回复")' }]
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
    await panel.getByRole('button', { name: '新任务', exact: true }).click()
    await expect(input).toHaveValue('')
  })
}

test('生成期间可新建和切换任务，独立保留草稿、回复与停止状态', async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Agent 对话工作区', exact: true })
  const input = panel.getByRole('textbox', { name: '向 Agent 提问' })
  await expect(input).toBeEditable()
  await expect(panel.getByRole('button', { name: '运行记录', exact: true })).toHaveCount(0)
  await page.evaluate(() => {
    const original = window.fetch.bind(window)
    const requests: { sessionId: string; aborted: boolean; controller: ReadableStreamDefaultController<Uint8Array> }[] = []
    const encoder = new TextEncoder()
    Object.assign(window, { concurrentAgentTest: { requests, finish: (index: number) => {
      const controller = requests[index].controller
      controller.enqueue(encoder.encode('data: {"type":"text-end","id":"reply"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n'))
      controller.close()
    } } })
    window.fetch = async (url, options) => {
      if (!String(url).endsWith('/api/agent')) return original(url, options)
      const body = JSON.parse(String(options?.body))
      return new Response(new ReadableStream({ start(controller) {
        const request = { sessionId: body.sessionId, aborted: false, controller }
        requests.push(request)
        options?.signal?.addEventListener('abort', () => { request.aborted = true }, { once: true })
        const events = [{ type: 'start' }, { type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: `root = TextContent("${body.prompt}的独立回复")` }]
        controller.enqueue(encoder.encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')))
      } }), { headers: { 'Content-Type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } })
    }
  })
  await input.fill('第一并发任务')
  await panel.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(panel.getByText('第一并发任务的独立回复', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: '新任务', exact: true })).toBeEnabled()
  await panel.getByRole('button', { name: '新任务', exact: true }).click()
  await expect(input).toHaveValue('')
  await panel.getByRole('button', { name: /^切换会话：/ }).click()
  await expect(page.getByRole('option', { name: /第一并发任务/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await input.fill('第二并发任务')
  await panel.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(panel.getByText('第二并发任务的独立回复', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => Reflect.get(window, 'concurrentAgentTest').requests.map((request: { sessionId: string; aborted: boolean }) => ({ sessionId: request.sessionId, aborted: request.aborted })))).toEqual([
    { sessionId: expect.any(String), aborted: false }, { sessionId: expect.any(String), aborted: false },
  ])
  expect(await page.evaluate(() => new Set(Reflect.get(window, 'concurrentAgentTest').requests.map((request: { sessionId: string }) => request.sessionId)).size)).toBe(2)

  await panel.getByRole('button', { name: /^切换会话：/ }).click()
  await page.getByRole('option', { name: /第一并发任务/ }).click()
  await expect(input).toHaveValue('第一并发任务')
  await expect(panel.getByText('第一并发任务的独立回复', { exact: true })).toBeVisible()
  await expect(panel.getByText('第二并发任务的独立回复', { exact: true })).toHaveCount(0)
  await panel.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(input).toBeEditable()
  await input.fill('第一任务保留的草稿')
  expect(await page.evaluate(() => Reflect.get(window, 'concurrentAgentTest').requests.map((request: { aborted: boolean }) => request.aborted))).toEqual([true, false])

  await page.evaluate(() => Reflect.get(window, 'concurrentAgentTest').finish(1))
  await panel.getByRole('button', { name: /^切换会话：/ }).click()
  await page.getByRole('option', { name: /第二并发任务/ }).click()
  await expect(panel.getByText('第二并发任务的独立回复', { exact: true })).toBeVisible()
  await expect(input).toHaveValue('')
  await expect(panel.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
  await panel.getByRole('button', { name: /^切换会话：/ }).click()
  await page.getByRole('option', { name: /第一并发任务/ }).click()
  await expect(input).toHaveValue('第一任务保留的草稿')
  expect(await page.evaluate(() => Reflect.get(window, 'concurrentAgentTest').requests.length)).toBe(2)
  await expect(panel).toHaveCount(1)
  await expect(panel.getByRole('alert')).toHaveCount(0)
})

test('标题下拉切换历史，右侧图标搜索和新建，桌面与手机均不占侧栏空间', async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Agent 对话工作区', exact: true })
  const input = panel.getByRole('textbox', { name: '向 Agent 提问' })
  const switcher = panel.getByRole('button', { name: /^切换会话：/ })
  await expect(panel.getByText('Agent 工作区 · DS 4.1 Flash', { exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '切换对话侧栏' })).toHaveCount(0)
  await expect(panel.getByRole('complementary', { name: '对话导航' })).toHaveCount(0)
  await switcher.click()
  await expect(page.getByText('暂无历史会话', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(switcher).toBeFocused()

  await page.route('**/api/agent', route => route.fulfill({
    status: 200, contentType: 'text/event-stream', headers: { 'x-vercel-ai-ui-message-stream': 'v1' },
    body: openUIStream(`root = TextContent(${JSON.stringify(`${route.request().postDataJSON().prompt}的回复`)})`),
  }))
  for (const title of ['香港景点', '项目计划']) {
    await input.fill(title)
    await panel.getByRole('button', { name: '发送消息' }).click()
    await expect(panel.getByText(`${title}的回复`, { exact: true })).toBeVisible()
    await expect(switcher).toHaveText(title)
    await panel.getByRole('button', { name: '新任务', exact: true }).click()
  }
  await input.fill('新任务的独立草稿')

  for (const width of [1159, 390]) {
    await page.setViewportSize({ width, height: 851 })
    for (const name of ['新任务', '搜索']) {
      const button = panel.locator('header').getByRole('button', { name, exact: true })
      await expect(button).toBeVisible()
      await expect(button).toHaveText('')
    }
    await panel.getByRole('button', { name: '搜索', exact: true }).click()
    const search = page.getByRole('combobox', { name: '搜索历史会话', exact: true })
    await expect(search).toBeFocused()
    await search.fill('不存在的历史')
    await expect(page.getByText('未找到相关会话', { exact: true })).toBeVisible()
    await search.fill('香港')
    await expect(page.getByRole('option', { name: /^香港景点/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /^项目计划/ })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await search.press('Enter')
    await expect(switcher).toHaveText('香港景点')
    await expect(search).toHaveCount(0)
    await expect(panel.getByText('香港景点的回复', { exact: true })).toBeVisible()
    const followUp = `${width} 像素下的下一轮问题`
    await input.fill(followUp)
    await panel.getByRole('button', { name: '发送消息' }).click()
    await expect(panel.getByText(`${followUp}的回复`, { exact: true })).toBeVisible()
    await expect(switcher).toHaveText('香港景点')
    await panel.getByRole('button', { name: '新任务', exact: true }).click()
    await expect(input).toHaveValue('')
  }
  await switcher.click()
  await expect(page.getByRole('group', { name: '今天', exact: true })).toBeVisible()
  await expect(page.getByRole('option', { name: /^项目计划/ })).toContainText('今天')
  await page.keyboard.press('Escape')
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

test('beUI 注册组件展示用户数字且动效按钮直���提问并保留草稿', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Agent 对话工作区' })
  const input = panel.getByRole('textbox', { name: '向 Agent 提问' })
  let requests = 0
  await page.route('**/api/agent', route => {
    requests++
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'x-vercel-ai-ui-message-stream': 'v1' },
      body: openUIStream(requests > 1 ? 'root = TextContent("已直接细化任务建议。")' : `root = Stack([badge, statistic, button])
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
  await input.fill('保留独立草稿')
  await panel.getByRole('button', { name: '继续细化', exact: true }).click()
  await expect(panel.getByText('已直接细化任务建议。', { exact: true })).toBeVisible()
  await expect(input).toHaveValue('保留独立草稿')
  await expect(input).not.toBeFocused()
  await expect(panel.getByRole('button', { name: '已提问', exact: true })).toBeDisabled()
  expect(requests).toBe(2)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('beUI 功能组展示回复与计划，审批和多步回答直接继续且不覆盖草稿', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Agent 对话工作区' })
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
  await expect(panel.getByRole('button', { name: '发送消息' })).toBeDisabled()
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
  await expect(panel.getByRole('article', { name: 'Agent 回复', exact: true })).toHaveCount(3)
  await expect(panel.getByRole('button', { name: '提交回答并继续', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await panel.getByRole('button', { name: '新任务', exact: true }).click()
  await expect(panel.getByRole('article', { name: 'Agent 回复', exact: true })).toHaveCount(0)
  await expect(input).toHaveValue('')
})

test('beUI 内联回答失败与停止后���留选择，可在原卡片重试且不重复提交', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Agent 对话工作区' })
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
  expect(submissions[2]).toEqual({ ...submissions[1], retry: true })
  await expect(panel.getByRole('article', { name: 'Agent 回复', exact: true })).toHaveCount(2)
})

test('旧按钮直接提问，纯文本在原卡片回答且失败可重试', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Agent 对话工作区' })
  const input = panel.getByRole('textbox', { name: '向 Agent 提问' })
  const submissions: { prompt: string; sessionId: string }[] = []
  await page.route('**/api/agent', async route => {
    submissions.push(route.request().postDataJSON())
    if (submissions.length === 2) await new Promise(resolve => setTimeout(resolve, 300))
    const body = submissions.length === 1
      ? openUIStream(`root = Stack([note, question, button])
note = ShadcnAlert("需要更多信息", "在下方补充你的需求，直接提交即可。")
question = BeQuestions("为 Orvilo 工作台提供任务建议，用户尚未说明具体需求。", [{ id: "goal", title: "你想完成什么任务？", allowCustom: true }])
button = BeButton("填入提问", "为 Orvilo 本周任务建议一个计划结构，仅建议不执行。", "outline")`)
      : submissions.length === 2
        ? 'data: {"type":"error","errorText":"测试：提问失败，请在原卡片重试。"}\n\ndata: [DONE]\n\n'
        : openUIStream(`root = TextContent("第 ${submissions.length} 次请求直接继续成功。")`)
    return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'x-vercel-ai-ui-message-stream': 'v1' }, body })
  })
  await input.fill('1')
  await panel.getByRole('button', { name: '发送消息' }).click()
  await expect(panel.getByRole('heading', { name: '你想完成什么任务？' })).toBeVisible()
  await expect(panel.getByRole('button', { name: '填入提问', exact: true })).toHaveCount(0)
  await input.fill('主输入框中的独立草稿')
  const quick = panel.getByRole('button', { name: '直接提问', exact: true })
  await quick.dblclick()
  await expect(panel.getByText('本次继续未完成，选择和回答已保留，可以在此重试。', { exact: true })).toBeVisible()
  expect(submissions).toHaveLength(2)
  await expect(input).toHaveValue('主输入框中的独立草稿')
  await quick.click()
  await expect(panel.getByText('第 3 次请求直接继续成功。', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: '已提问', exact: true })).toBeDisabled()
  expect(submissions[2]).toEqual({ ...submissions[1], retry: true })
  const answer = panel.getByRole('textbox', { name: '你想完成什么任务？：补充回答' })
  await answer.fill('请帮我整理一份本周任务清单')
  await panel.getByRole('button', { name: '提交回答并继续', exact: true }).click()
  await expect(panel.getByText('第 4 次请求直接继续成功。', { exact: true })).toBeVisible()
  expect(submissions[3].prompt).toContain('你想完成什么任务？：请帮我整理一份本周任务清单')
  expect(submissions.every(body => body.sessionId === submissions[0].sessionId)).toBe(true)
  await expect(input).toHaveValue('主输入框中的独立草稿')
  await expect(panel.getByRole('button', { name: '提交回答并继续', exact: true })).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await panel.getByRole('button', { name: '新任务', exact: true }).click()
  await expect(input).toHaveValue('')
  await expect(panel.getByRole('article', { name: 'Agent 回复', exact: true })).toHaveCount(0)
})

test('真实配图异步展示来源，支持放大缩放和 Escape 关闭，失败不影响正文', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Agent 对话工作区' })
  const input = panel.getByRole('textbox', { name: '向 Agent 提问' })
  await page.route('**/api/agent', route => route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'x-vercel-ai-ui-message-stream': 'v1' }, body: openUIStream('root = Stack([TextContent("正文不等待配图加载。"), BeImage("Hong Kong Victoria Harbour", "维多利亚港资料配图", "维多利亚港现代风光")])') }))
  const imageUrl = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a4/Hong_Kong_Harbour_Night_2019-06-11.jpg/960px-Hong_Kong_Harbour_Night_2019-06-11.jpg'
  await page.route('**/api/agent?q=*', route => route.fulfill({ json: { image: { src: imageUrl, width: 960, height: 454, title: 'Hong Kong Harbour Night 2019-06-11.jpg', source: 'https://commons.wikimedia.org/wiki/File:Hong_Kong_Harbour_Night_2019-06-11.jpg', author: 'Benh LIEU SONG', license: 'CC BY-SA 4.0' } } }))
  await input.fill('介绍维多利亚港并配图')
  await panel.getByRole('button', { name: '发送消息' }).click()
  await expect(panel.getByText('正文不等待配图加载。', { exact: true })).toBeVisible()
  const thumbnail = panel.getByRole('button', { name: '放大查看：维多利亚港资料配图', exact: true })
  await expect(thumbnail).toBeVisible()
  await expect(panel.getByRole('link', { name: /Wikimedia Commons/ })).toContainText('CC BY-SA 4.0')
  await thumbnail.click()
  const viewer = page.getByRole('dialog', { name: '资料配图查看器', exact: true })
  await expect(viewer).toBeVisible()
  await viewer.getByRole('button', { name: '放大图片', exact: true }).click()
  await expect(viewer.getByRole('button', { name: '缩小图片', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await expect(thumbnail).toBeFocused()
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.route('**/api/agent?q=*', route => route.fulfill({ json: { image: null } }))
  await page.route('**/api/agent', route => route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'x-vercel-ai-ui-message-stream': 'v1' }, body: openUIStream('root = Stack([TextContent("没有配图仍显示完整正文。"), BeImage("Missing photo query", "暂无配图")])') }))
  await input.fill('没有检索结果的配图')
  await panel.getByRole('button', { name: '发送消息' }).click()
  await expect(panel.getByText('没有配图仍显示完整正文。', { exact: true })).toBeVisible()
  await expect(panel.getByText(/未找到“Missing photo query”的可用配图/)).toBeVisible()
})

test('紧凑图文卡片使用 beUI Card、来源可展开、无冗余等待文案', async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Agent 对话工作区' })
  const input = panel.getByRole('textbox', { name: '向 Agent 提问' })
  let releaseImage!: () => void
  const imageReady = new Promise<void>(resolve => { releaseImage = resolve })
  const imageUrl = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/hong-kong.jpg'
  await page.route(imageUrl, route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#ddd"/></svg>' }))
  await page.route('**/api/agent?q=*', async route => {
    await imageReady
    await route.fulfill({ json: { image: { src: imageUrl, width: 960, height: 540, title: 'Hong Kong', source: 'https://commons.wikimedia.org/wiki/File:Hong_Kong.jpg', author: '摄影师', license: 'CC BY-SA 4.0' } } })
  })
  const cards = 'root = Stack([intro, cards])\nintro = TextContent("香港景点速览")\ncards = BeCardGrid([BeImageCard("太平山顶", "Victoria Peak", "山顶看维港全景。", ["城市全景"]), BeImageCard("维多利亚港", "Victoria Harbour", "海滨步道适合散步。", ["海滨散步"])])'
  await page.route('**/api/agent', route => route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'x-vercel-ai-ui-message-stream': 'v1' }, body: openUIStream(cards) }))
  await input.fill('介绍香港景点')
  await panel.getByRole('button', { name: '发送消息' }).click()
  await expect(panel.getByText('香港景点速览', { exact: true })).toBeVisible()
  await expect(panel.getByText('山顶看维港全景。', { exact: true })).toBeVisible()
  await expect(panel.getByText(/正在查找真实配图|不影响正文生成/)).toHaveCount(0)
  const card = panel.getByRole('group', { name: '太平山顶', exact: true })
  await expect(card).toHaveAttribute('data-slot', 'card')
  await expect(card).toHaveClass(/py-4/)
  const grid = panel.getByRole('group', { name: '图文推荐卡片', exact: true })
  expect(await grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBeGreaterThan(1)
  releaseImage()
  await card.getByRole('button', { name: '图片来源与许可', exact: true }).click()
  await expect(card.getByRole('link', { name: /CC BY-SA 4.0/ })).toBeVisible()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('可恢复格式不报错，真正缺段可原位重试且不覆盖草稿', async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Agent 对话工作区' })
  const input = panel.getByRole('textbox', { name: '向 Agent 提问' })
  await page.route('**/api/agent', route => route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'x-vercel-ai-ui-message-stream': 'v1' }, body: openUIStream('root = TextContent("格式已自动恢复的完整正文"') }))
  await input.fill('验证格式恢复')
  await panel.getByRole('button', { name: '发送消息' }).click()
  await expect(panel.getByText('格式已自动恢复的完整正文', { exact: true })).toBeVisible()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await page.route('**/api/agent', route => route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'x-vercel-ai-ui-message-stream': 'v1' }, body: openUIStream('root = Stack([TextContent("已收到的正文"), missing])') }))
  await input.fill('验证真实缺段')
  await panel.getByRole('button', { name: '发送消息' }).click()
  await expect(panel.getByRole('alert')).toContainText('没有返回这些段落')
  await expect(panel.getByText('已收到的正文', { exact: true })).toBeVisible()
  await input.fill('这是未发送的独立草稿')
  let retryPrompt = ''
  await page.route('**/api/agent', route => {
    retryPrompt = route.request().postDataJSON().prompt
    return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'x-vercel-ai-ui-message-stream': 'v1' }, body: openUIStream('root = TextContent("重试后返回完整正文")') })
  })
  await panel.getByRole('button', { name: '重试此回复', exact: true }).click()
  await expect(panel.getByText('重试后返回完整正文', { exact: true })).toBeVisible()
  expect(retryPrompt).toBe('验证真实缺段')
  await expect(input).toHaveValue('这是未发送的独立草稿')
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await expect(panel.getByRole('article', { name: 'Agent 回复', exact: true })).toHaveCount(2)
})

const generatedUI = `root = Stack([heading, tabs, form, note])
heading = TextContent("项目规划建议", "large-heavy")
tabs = Tabs([TabItem("plan", "阶段计划", [table]), TabItem("summary", "交付说明", [description])])
table = Table([Col("阶段", ["需求梳理", "方案验证"]), Col("交付物", ["需求清单", "交互原型"])])
description = TextContent("以上为建议计划，尚未保存到工作区。")
form = Form("refine", buttons, [field])
field = FormControl("项目名称", Input("projectName", "输入项目名称", "text", { required: true }))
buttons = Buttons([Button("提交回答并继续", @ToAssistant("请根据填写的项目名称细化项目计划"), "primary")])
note = TextContent("表单提交后直接继续提供建议，不会创建项目。")`

test('代码块按需高亮，正文和复制功能保持可用', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Agent 对话工作区' })
  const code = 'const answer = 42;'
  const response = `root = TextContent(${JSON.stringify(`代码示例：\n\n\`\`\`javascript\n${code}\n\`\`\``)})`
  await page.route('**/api/agent', route => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    headers: { 'x-vercel-ai-ui-message-stream': 'v1' },
    body: openUIStream(response),
  }))
  await panel.getByRole('textbox', { name: '向 Agent 提问' }).fill('给出 JavaScript 代码示例')
  await panel.getByRole('button', { name: '发送消息' }).click()
  await expect(panel.getByText('代码示例：', { exact: true })).toBeVisible()
  const block = panel.locator('.agent-code-block')
  await expect(block).toContainText(code)
  const keyword = block.locator('code span').filter({ hasText: /^const$/ })
  await expect(keyword).toHaveAttribute('style', /--agent-code-light:.*--agent-code-dark:/)
  await expect.poll(() => keyword.evaluate(element => getComputedStyle(element).color)).not.toBe('rgba(0, 0, 0, 0)')
  await panel.getByRole('button', { name: '复制代码', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(code)
  await expect(panel.getByRole('alert')).toHaveCount(0)
})

test('OpenUI 表格、Tabs 和表单直接提交，兼容按钮续问且会话稳定', async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Agent 对话工作区' })
  const input = panel.getByRole('textbox', { name: '向 Agent 提问' })
  const sessionIds: string[] = []
  let requests = 0
  await page.route('**/api/agent', route => {
    requests++
    const body = route.request().postDataJSON()
    sessionIds.push(body.sessionId)
    return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'x-vercel-ai-ui-message-stream': 'v1' }, body: openUIStream(requests === 1 ? generatedUI : 'root = TextContent("已根据项目名称继续提供建议。")') })
  })
  await input.fill('请用表格和表单给出项目计划建议')
  await panel.getByRole('button', { name: '发送消息' }).click()
  await panel.getByRole('tab', { name: '阶段计划', exact: true }).click()
  await expect(panel.getByRole('columnheader', { name: '阶段', exact: true })).toBeVisible()
  await expect(panel.getByRole('cell', { name: '需求梳理', exact: true })).toBeVisible()
  await panel.getByRole('tab', { name: '交付说明' }).click()
  await expect(panel.getByText('以上为建议计划，尚未保存到工作区。', { exact: true })).toBeVisible()
  await panel.getByRole('tab', { name: '阶段计划' }).click()
  await input.fill('未发送的表单外草稿')
  await panel.getByRole('textbox', { name: /^项目名称/ }).fill('Orvilo 发布')
  await panel.getByRole('button', { name: '提交回答并继续', exact: true }).click()
  await expect(panel.getByText('已根据项目名称继续提供建议。', { exact: true })).toBeVisible()
  await expect(input).toHaveValue('未发送的表单外草稿')
  await expect(input).not.toBeFocused()
  expect(requests).toBe(2)
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await expect(panel.getByText(/root = Stack/)).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
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
  await input.fill('本地组件外的草稿')
  await page.route('**/api/agent', route => route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'x-vercel-ai-ui-message-stream': 'v1' }, body: openUIStream('root = TextContent("本地组件建议已直接细化。")') }))
  await panel.getByRole('button', { name: '继续细化', exact: true }).click()
  await expect(panel.getByText('本地组件建议已直接细化。', { exact: true })).toBeVisible()
  await expect(input).toHaveValue('本地组件外的草稿')
  await expect(panel.getByRole('alert')).toHaveCount(0)
  expect(requests).toBe(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await page.route('**/api/agent', route => route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'x-vercel-ai-ui-message-stream': 'v1' }, body: openUIStream('root = Stack([missing])') }))
  await input.fill('测试不完整的模型输出')
  await panel.getByRole('button', { name: '发送消息' }).click()
  await expect(panel.getByRole('alert')).toContainText('回复缺少部分内容')
  await expect(panel.getByRole('alert')).toContainText('没有返回这些段落')
  await expect(panel.getByRole('alert')).not.toContainText('简化问题')
  await expect(panel.getByRole('button', { name: '重试此回复', exact: true })).toBeVisible()
})
