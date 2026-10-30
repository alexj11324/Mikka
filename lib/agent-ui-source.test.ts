import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectAgentUISource, normalizeAgentUISource } from './agent-ui-source'

test('plain Markdown stays Markdown, untouched', () => {
  const source = '# 你好\n\n今天先做什么？'
  assert.deepEqual(detectAgentUISource(source), { isOpenUI: false, source })
})

test('the welcome card without root = is recognised and gets it back', () => {
  const source = `Stack([
TextContent("你好，acme! 我是协调员。"),
BeQuestions("你想先做什么？", [{id:"start", title:"开始", options:[{value:"a", label:"查看当前问题"}, {value:"b", label:"创建新任务"}, {value:"c", label:"查看日程"}, {value:"d", label:"搜索帮助"}], allowCustom:true}])
])`
  const detected = detectAgentUISource(source)
  assert.equal(detected.isOpenUI, true)
  assert.equal(detected.source, `root = ${source}`)
})

test('root = source runs the escaping normaliser', () => {
  const source = 'root = Stack([TextContent("第一行\\n第二行"), TextContent("bad \\q escape")])'
  const detected = detectAgentUISource(source)
  assert.equal(detected.isOpenUI, true)
  assert.equal(detected.source, normalizeAgentUISource(source))
  assert.match(detected.source, /第一行\\n第二行/)
  assert.match(detected.source, /bad \\\\q escape/)
})

test('a double-quoted // stays a string value, not a comment', () => {
  const source = 'root = Stack([TextContent("https://example.com/a")])'
  assert.equal(detectAgentUISource(source).source, source)
})

test('a component call that drops root = is normalised too', () => {
  const source = 'BeResponse([TextContent("bad \\q escape")])'
  const detected = detectAgentUISource(source)
  assert.equal(detected.isOpenUI, true)
  assert.equal(detected.source, normalizeAgentUISource(`root = ${source}`))
  assert.match(detected.source, /bad \\\\q escape/)
})

test('prose that mentions a component is not a card', () => {
  for (const source of [
    'Stack is how cards are arranged. Use Stack([…]) to group them.',
    'The `Stack(` component groups cards.',
    'You can write Stack(...) for a vertical layout.',
    'Stack() alone says nothing.',
    'BeCards look nice.',
  ]) {
    assert.deepEqual(detectAgentUISource(source), { isOpenUI: false, source }, source)
  }
})

test('leading whitespace before a component call is fine', () => {
  const source = '\n  Stack([\n    TextContent("hi")\n  ])'
  const detected = detectAgentUISource(source)
  assert.equal(detected.isOpenUI, true)
  assert.equal(detected.source, `root = ${source.trimStart()}`)
})

test('root = may follow leading lines, as before', () => {
  assert.equal(detectAgentUISource('\n\nroot = Stack([])').isOpenUI, true)
})

test('root = in code fences or prose is not OpenUI', () => {
  for (const source of [
    'Here is the fix:\n\n```python\nroot = Path(__file__).parent\n```\n',
    'Try:\n```js\nconst x = 1\nroot = document.getElementById("app")\n```',
    'Set the variable like this:\nroot = /var/www',
    '~~~\nroot = Stack([])\n~~~',
  ]) assert.equal(detectAgentUISource(source).isOpenUI, false, source)
})

test('root = Component(…) after a fence is still OpenUI', () => {
  assert.equal(detectAgentUISource('```\nx\n```\nroot = Stack([TextContent("hi")])').isOpenUI, true)
  assert.equal(detectAgentUISource('root =Stack([])').isOpenUI, true)
})
