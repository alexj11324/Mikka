import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createParser, generateSystemPrompt } from '@openuidev/lang-core'
import { agentComponentCatalog, agentComponentGroups, createAgentLibrary } from '../lib/agent-ui-catalog.ts'

const library = createAgentLibrary()
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
