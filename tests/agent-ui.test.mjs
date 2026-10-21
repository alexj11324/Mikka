import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createParser, generateSystemPrompt } from '@openuidev/lang-core'
import { agentComponentCatalog, createAgentLibrary } from '../lib/agent-ui-catalog.ts'

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
  for (const name of ['BeButton', 'BeBadge', 'BeStat']) {
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
