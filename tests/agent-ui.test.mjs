import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createParser, generateSystemPrompt } from '@openuidev/lang-core'
import { agentComponentCatalog, agentComponentGroups, createAgentLibrary } from '../lib/agent-ui-catalog.ts'
import { agentImageQuery, findAgentImage, parseAgentImage } from '../lib/agent-images.ts'
import { getAgentUIIssue } from '../lib/agent-ui-status.ts'

function commonsImage(overrides = {}) {
  return { title: 'File:Victoria Harbour.jpg', index: 1, imageinfo: [{ thumburl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/photo.jpg', thumbwidth: 960, thumbheight: 540, descriptionurl: 'https://commons.wikimedia.org/wiki/File:Victoria_Harbour.jpg', mime: 'image/jpeg', extmetadata: { Artist: { value: '<a>摄影师</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' } }, ...overrides }] }
}

test('图片解析保留真实来源和许可，拒绝不安全资源', () => {
  const image = parseAgentImage({ query: { pages: { 1: commonsImage() } } })
  assert.equal(image.author, '摄影师')
  assert.equal(image.license, 'CC BY-SA 4.0')
  assert.equal(image.width, 960)
  for (const unsafe of [
    { thumburl: 'javascript:alert(1)' },
    { thumburl: 'https://127.0.0.1/private' },
    { thumburl: 'https://upload.wikimedia.org.evil.test/image.jpg' },
    { descriptionurl: 'https://evil.test/phishing' },
    { mime: 'image/svg+xml' },
    { thumbwidth: -1 },
    { extmetadata: {} },
  ]) assert.equal(parseAgentImage({ query: { pages: { 1: commonsImage(unsafe) } } }), null)
  assert.equal(parseAgentImage({ error: 'unavailable' }), null)
  for (const query of ['https://evil.test', '<script>', 'a\nb']) {
    assert.equal(agentImageQuery.safeParse(query).success, false)
    assert.equal(agentComponentCatalog.BeImage.props.safeParse({ query, alt: '资料配图' }).success, false)
  }
})

test('配图检索通过固定来源查询，并正确处理无结果及上游错误', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url.origin, 'https://commons.wikimedia.org')
    assert.equal(url.searchParams.get('gsrnamespace'), '6')
    assert.match(url.searchParams.get('gsrsearch'), /Victoria Harbour/)
    return Response.json({ query: { pages: { 1: commonsImage() } } })
  })
  assert.equal((await findAgentImage('Victoria Harbour')).license, 'CC BY-SA 4.0')
  globalThis.fetch.mock.mockImplementation(async () => Response.json({ query: { pages: {} } }))
  assert.equal(await findAgentImage('Victoria Harbour'), null)
  globalThis.fetch.mock.mockImplementation(async () => new Response(null, { status: 503 }))
  await assert.rejects(findAgentImage('Victoria Harbour'), /暂时不可用/)
})

test('资料配图和详细回答规则进入模型规范', async () => {
  const spec = JSON.parse(await readFile(new URL('../lib/agent-ui.spec.json', import.meta.url), 'utf8'))
  assert.ok(spec.promptOptions.additionalRules.some(rule => rule.includes('不设简短回答偏好') && rule.includes('不能用一张摘要表')))
  assert.ok(spec.promptOptions.additionalRules.some(rule => rule.includes('BeImage') && rule.includes('真实配图')))
  const result = createParser(library.toJSONSchema(), library.root).parse('root = Stack([TextContent("介绍"), BeImage("Hong Kong Victoria Harbour", "维多利亚港资料配图", "现代风光资料图片")])')
  assert.ok(result.root)
  assert.deepEqual(result.meta.errors, [])
})

const library = createAgentLibrary()

test('完整正文和可自动补齐的括号不会误报失败', () => {
  const parser = createParser(library.toJSONSchema(), library.root)
  for (const source of ['root = TextContent("完整正文")', 'root = TextContent("完整正文"']) {
    const result = parser.parse(source)
    assert.ok(result.root)
    assert.deepEqual(result.meta.errors, [])
    assert.equal(getAgentUIIssue(result), null)
  }
})

test('真实缺少段落与组件格式错误分别说明原因', () => {
  const parser = createParser(library.toJSONSchema(), library.root)
  const missing = getAgentUIIssue(parser.parse('root = Stack([TextContent("已有正文"), missing])'))
  assert.match(missing.message, /没有返回这些段落/)
  assert.match(missing.message, /已收到的内容会保留/)
  const invalid = getAgentUIIssue(parser.parse('root = ShadcnTable("错误类型", [])'))
  assert.match(invalid.message, /表格数据格式不正确/)
  assert.match(getAgentUIIssue(null).message, /内容格式有误/)
  assert.equal(getAgentUIIssue(parser.parse('root = TextContent("正文")'), [{ source: 'parser', code: 'no-root', severity: 'warning', message: 'recoverable' }]), null)
})

test('紧凑推荐卡片可解析且模型规范优先小卡片', async () => {
  const parser = createParser(library.toJSONSchema(), library.root)
  const result = parser.parse('root = BeCardGrid([BeImageCard("太平山顶", "Victoria Peak Hong Kong", "俯瞰维港，建议日落前上山。", ["城市全景"])])')
  assert.ok(result.root)
  assert.deepEqual(result.meta.errors, [])
  assert.deepEqual(result.meta.unresolved, [])
  const spec = JSON.parse(await readFile(new URL('../lib/agent-ui.spec.json', import.meta.url), 'utf8'))
  assert.ok(spec.promptOptions.additionalRules.some(rule => rule.includes('BeCardGrid') && rule.includes('不要逐条堆放通栏 BeImage')))
  const image = await readFile(new URL('../components/workspace/agent-image.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(image, /正在查找真实配图|不影响正文生成|不使用占位图片/)
  const card = await readFile(new URL('../components/workspace/agent-image-card.tsx', import.meta.url), 'utf8')
  assert.ok(card.includes("from '@/components/motion/card'"))
  assert.match(card, /size="compact"/)
  assert.doesNotMatch(card, /from ['"]@\/components\/ui\/card/)
  const contentCard = parser.parse('root = BeCard("建议", [TextContent("完整建议内容")], "内容分组")')
  assert.ok(contentCard.root)
  assert.deepEqual(contentCard.meta.errors, [])
})

const beuiResponse = `root = Stack([badge, statistic, button])
badge = BeBadge("用户提供的状态", "info")
statistic = BeStat("本周完成任务", 12, "项", 0)
button = BeButton("继续细化", "请根据本周完成12项任务的数据给出改进建议", "outline")`

test('beUI 组件包含在运行时和可序列化规范中', async () => {
  const spec = JSON.parse(await readFile(new URL('../lib/agent-ui.spec.json', import.meta.url), 'utf8'))
  assert.deepEqual(spec.library, JSON.parse(JSON.stringify(library.toSpec())))
  assert.deepEqual(spec.localComponents, Object.keys(agentComponentCatalog))
  const prompt = generateSystemPrompt(spec)
  for (const name of Object.keys(agentComponentCatalog)) {
    assert.ok(library.components[name])
    assert.ok(spec.library.schema.$defs[name])
    assert.match(prompt, new RegExp(`${name}\\(`))
  }
  assert.match(prompt, /数字只能来自用户输入/)
  assert.match(prompt, /不保存历史/)
})

test('beUI OpenUI Lang 输出可解析且保留旧组件兼容', () => {
  const parser = createParser(library.toJSONSchema(), library.root)
  const result = parser.parse(beuiResponse)
  assert.ok(result.root)
  assert.equal(result.meta.incomplete, false)
  assert.deepEqual(result.meta.unresolved, [])
  assert.deepEqual(result.meta.errors, [])
  for (const name of ['ShadcnCard', 'ShadcnButton', 'ReuiFrame', 'Tabs', 'Form', 'Table']) {
    assert.ok(library.components[name])
  }
})

test('功能分组完整且每个本地组件仅属于一个功能组', () => {
  const names = agentComponentGroups.flatMap(group => group.components)
  assert.deepEqual([...names].sort(), Object.keys(agentComponentCatalog).sort())
  assert.equal(new Set(names).size, names.length)
  assert.equal(agentComponentGroups.length, 5)
})

test('审批、问题、回复和任务计划均可解析', () => {
  const parser = createParser(library.toJSONSchema(), library.root)
  const result = parser.parse(`root = Stack([response, approval, questions, tasks, icon])
response = BeResponse([TextContent("建议内容")])
approval = BeApproval("确认建议", "仅填入提问", "本次项目计划建议")
questions = BeQuestions("为项目选择范围", [{ id: "scope", title: "选择范围", options: [{ value: "small", label: "精简版" }], allowCustom: true }])
tasks = BeTodoList("建议计划", [{ id: "task-1", title: "整理需求", status: "pending" }], "suggestion")
icon = AgentIcon("question", "等待回答")`)
  assert.ok(result.root)
  assert.equal(result.meta.incomplete, false)
  assert.deepEqual(result.meta.errors, [])
  assert.deepEqual(result.meta.unresolved, [])
})

test('问题、任务与图标严格限制输入，不能伪造审批结果', () => {
  const { BeQuestions, BeTodoList, AgentIcon, BeApproval } = agentComponentCatalog
  const valid = { context: '项目建议', questions: [{ id: 'scope', title: '选择范围', allowCustom: true }] }
  assert.equal(BeQuestions.props.safeParse(valid).success, true)
  assert.equal(BeQuestions.props.safeParse({ ...valid, questions: [] }).success, false)
  assert.equal(BeQuestions.props.safeParse({ ...valid, questions: [...valid.questions, ...valid.questions] }).success, false)
  assert.equal(BeQuestions.props.safeParse({ ...valid, questions: [{ id: 'empty', title: '无法回答' }] }).success, false)
  assert.equal(BeQuestions.props.safeParse({ ...valid, questions: [{ id: 'scope', title: '选择范围', options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] }] }).success, false)
  assert.equal(BeTodoList.props.safeParse({ title: '建议计划', items: [{ id: 'one', title: '任务', progress: 101 }] }).success, false)
  assert.equal(AgentIcon.props.safeParse({ name: 'arbitrary-script', label: '危险' }).success, false)
  assert.equal(AgentIcon.props.safeParse({ name: 'approve', label: '等待确认' }).success, true)
  assert.equal('status' in BeApproval.props.shape, false)
  assert.equal('AgentProgress' in agentComponentCatalog, false)
  assert.equal('ToolApproval' in agentComponentCatalog, false)
})

test('49 项 AI Elements 对照不遗漏且 beUI 对应源码可导入', async () => {
  const coverage = JSON.parse(await readFile(new URL('../lib/agent-ui-coverage.json', import.meta.url), 'utf8'))
  const expected = ['Attachments', 'Chain of Thought', 'Checkpoint', 'Confirmation', 'Context', 'Conversation', 'Inline Citation', 'Message', 'Model Selector', 'Plan', 'Prompt Input', 'Question', 'Queue', 'Reasoning', 'Shimmer', 'Sources', 'Suggestion', 'Task', 'Tool', 'Agent', 'Artifact', 'Code Block', 'Commit', 'Environment Variables', 'File Tree', 'JSX Preview', 'Package Info', 'Sandbox', 'Schema Display', 'Snippet', 'Stack Trace', 'Terminal', 'Test Results', 'Web Preview', 'Image', 'Open In Chat', 'Audio Player', 'Mic Selector', 'Persona', 'Speech Input', 'Transcription', 'Voice Selector', 'Canvas', 'Connection', 'Controls', 'Edge', 'Node', 'Panel', 'Toolbar']
  assert.deepEqual(coverage.components.map(item => item.element).sort(), expected.sort())
  for (const entry of coverage.components) {
    assert.ok(entry.note)
    assert.ok(['functional', 'partial', 'none'].includes(entry.match))
    assert.equal(entry.match === 'none', entry.beui.length === 0)
    assert.equal(entry.match === 'none', entry.usage === 'unavailable')
    for (const slug of entry.beui) assert.ok(coverage.beui[slug], `${entry.element}: ${slug}`)
  }
  for (const [slug, entry] of Object.entries(coverage.beui)) {
    assert.equal(entry.source, `https://beui.dev/r/${slug}`)
    for (const path of [entry.path, ...entry.relatedPaths ?? []]) {
      assert.match(path, /^components\/(agents|motion)\//)
      const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
      assert.match(source, /export /, path)
      assert.doesNotMatch(source, /from ['"][^'"]*(?:ai-elements|@ai-sdk\/elements)/)
    }
  }
})

test('会话宿主直接组合 beUI，不回退到 AI Elements 或同名 shadcn 会话组件', async () => {
  for (const [file, expectedImport] of [
    ['agent-composer.tsx', 'prompt-input'],
    ['agent-conversation.tsx', 'message-scroller'],
    ['agent-conversation.tsx', 'message-bubble'],
    ['agent-conversation.tsx', 'message'],
    ['agent-response.tsx', 'streaming-response'],
    ['agent-response.tsx', 'loading-states/agent-progress'],
    ['agent-decision.tsx', 'approval-card'],
    ['agent-content.tsx', 'todo-list'],
  ]) {
    const source = await readFile(new URL(`../components/workspace/${file}`, import.meta.url), 'utf8')
    assert.ok(source.includes(`from '@/components/agents/${expectedImport}'`), file)
    assert.doesNotMatch(source, /from ['"][^'"]*(?:ai-elements|@ai-sdk\/elements|\/ui\/(?:message|message-scroller|bubble|input-group))/)
  }
  const starters = await readFile(new URL('../components/workspace/agent-starters.tsx', import.meta.url), 'utf8')
  assert.match(starters, /export const agentStarters/)
  assert.doesNotMatch(starters, /<Button|function AgentStarters/)
})

test('Chat App 保留官网外壳与输入配置，会话导航收进标题菜单', async () => {
  const source = await readFile(new URL('../components/workspace/agent-chat.tsx', import.meta.url), 'utf8')
  for (const name of ['ChatApp', 'AnimatedSidebarInset', 'Popover', 'PopoverTrigger', 'Command', 'CommandItem']) {
    assert.match(source, new RegExp(`<${name}[\\s>]`))
  }
  assert.doesNotMatch(source, /<AnimatedSidebar[\s>]|<AnimatedSidebarTrigger|<AISidebar/)
  assert.match(source, /aria-label=\{`切换会话：\$\{title\}`\}/)
  for (const label of ['新任务', '搜索']) assert.ok(source.includes(`size="icon" aria-label="${label}"`))
  assert.ok(source.includes("from '@/components/agents/chat-app'"))
  const conversation = await readFile(new URL('../components/workspace/agent-conversation.tsx', import.meta.url), 'utf8')
  assert.match(conversation, /<MessageGroup spacing="default">/)
  assert.match(conversation, /<MessageAvatar>/)
  assert.match(conversation, /variant="solid"/)
  assert.doesNotMatch(conversation, /<Empty|AgentStarters|有什么可以帮你/)
  const composer = await readFile(new URL('../components/workspace/agent-composer.tsx', import.meta.url), 'utf8')
  assert.match(composer, /minRows=\{1\}/)
  assert.match(composer, /models=\{/)
  assert.match(composer, /actions=\{/)
  assert.doesNotMatch(composer, /leadingAction|<Kbd/)
  const panel = await readFile(new URL('../components/workspace/agent-panel.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(panel, /starters=|AgentStarters/)
  assert.match(panel, /if \(question\) setPreviousTurns/)
  assert.match(panel, /result && source === 'composer'/)
  assert.match(panel, /current === prompt \? '' : current/)
  assert.match(panel, /continueFromAnswer: prompt => request\(prompt, 'inline'\)/)
})

test('服务端和 beUI 界面均使用 DS 4.1 Flash', async () => {
  const route = await readFile(new URL('../app/api/agent/route.ts', import.meta.url), 'utf8')
  const composer = await readFile(new URL('../components/workspace/agent-composer.tsx', import.meta.url), 'utf8')
  const chat = await readFile(new URL('../components/workspace/agent-chat.tsx', import.meta.url), 'utf8')
  assert.ok(route.includes("opencode('deepseek-v4.1-flash')"))
  assert.doesNotMatch(route, /maxOutputTokens\s*:|providerOptions\s*:|reasoning\s*:/)
  assert.match(route, /createOpenAICompatible/)
  assert.match(route, /validateAgentStream\(\)/)
  assert.ok(composer.includes('model="deepseek-v4.1-flash"'))
  assert.match(composer, /DS 4\.1 Flash/)
  assert.doesNotMatch(chat, /Agent 工作区|DS 4\.1 Flash/)
  for (const source of [route, composer, chat]) assert.doesNotMatch(source, /glm-5\.3|GLM-5\.3/)
})

test('停止按钮先取消表单默认行为，避免同步恢复后误发草稿', async () => {
  const source = await readFile(new URL('../components/agents/prompt-input.tsx', import.meta.url), 'utf8')
  assert.match(source, /onClick=\{loading \? event => \{[\s\S]*?event\.preventDefault\(\);\s*onStop\?\.\(\);/)
})

test('回复动作统一直接请求，澄清使用内联问题卡片', async () => {
  const panel = await readFile(new URL('../components/workspace/agent-panel.tsx', import.meta.url), 'utf8')
  const handler = panel.slice(panel.indexOf('async function handleUIAction'), panel.indexOf('async function request'))
  assert.match(handler, /request\(prompt, 'inline'\)/)
  assert.doesNotMatch(handler, /updateDraft|\.focus\(|\.slice\(/)
  const renderers = await readFile(new URL('../components/workspace/agent-ui-library.tsx', import.meta.url), 'utf8')
  assert.match(renderers, /send\(props.action\)/)
  assert.match(renderers, /send\(props.prompt\)/)
  assert.doesNotMatch(renderers, /useTriggerAction/)
  const spec = JSON.parse(await readFile(new URL('../lib/agent-ui.spec.json', import.meta.url), 'utf8'))
  assert.ok(spec.promptOptions.additionalRules.some(rule => rule.includes('所有回复内的按钮') && rule.includes('不填入、不聚焦、不清空')))
  assert.ok(spec.promptOptions.additionalRules.some(rule => rule.includes('需求模糊') && rule.includes('BeQuestions') && rule.includes('allowCustom=true')))
  for (const name of ['BeButton', 'ShadcnButton']) {
    const props = name === 'BeButton' ? { action: '请提供建议' } : { prompt: '请提供建议' }
    assert.equal(agentComponentCatalog[name].props.safeParse({ ...props, label: '直接提问' }).success, true)
    assert.equal(agentComponentCatalog[name].props.safeParse({ ...props, label: '填入提问' }).success, true)
  }
})

test('beUI 限制按钮语义、状态、数字和小数位', () => {
  const { BeButton, BeBadge, BeStat } = agentComponentCatalog
  assert.equal(BeButton.props.safeParse({ label: '继续细化', action: '请根据用户数据给出建议' }).success, true)
  assert.equal(BeButton.props.safeParse({ label: '已保存', action: 'save' }).success, false)
  assert.equal(BeBadge.props.safeParse({ text: '建议', status: 'arbitrary' }).success, false)
  for (const value of [Infinity, NaN, 1e13]) {
    assert.equal(BeStat.props.safeParse({ label: '用户输入', value }).success, false)
  }
  for (const precision of [-1, 5, 1.5]) {
    assert.equal(BeStat.props.safeParse({ label: '用户输入', value: 12.5, precision }).success, false)
  }
})
