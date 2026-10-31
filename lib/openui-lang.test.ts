import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentImageQuery } from './agent-images'
import { inlineMarkdown, isComponent, isImageQuery, openUIText, parseOpenUI, type Component } from './openui-lang'

const WELCOME = 'root = Stack([TextContent("你好，Alex！我是你的 Coordinator。"), BeQuestions("刚开始使用", [{id:"start", title:"想先从哪里开始？", options:[{value:"a", label:"整理收件箱"}, {value:"b", label:"看看今天的日程"}], allowCustom:true}])])'

test('reads a welcome card: text and a question with options', () => {
  const root = parseOpenUI(WELCOME) as Component
  assert.equal(root.name, 'Stack')
  const [text, questions] = root.props.children as Component[]
  assert.equal(text.props.text, '你好，Alex！我是你的 Coordinator。')
  assert.equal(questions.name, 'BeQuestions')
  assert.deepEqual(questions.props.questions, [{ id: 'start', title: '想先从哪里开始？', options: [{ value: 'a', label: '整理收件箱' }, { value: 'b', label: '看看今天的日程' }], allowCustom: true }])
})

test('follows references to other statements, escapes and numbers', () => {
  const root = parseOpenUI('root = Stack([intro, more])\nintro = TextContent("第一行\\n第二行 \\"引号\\"")\nmore = BeStat("完成", 3, "项", 0)') as Component
  const [intro, more] = root.props.children as Component[]
  assert.equal(intro.props.text, '第一行\n第二行 "引号"')
  assert.equal(more.name, 'BeStat')
  assert.deepEqual(more.args, ['完成', 3, '项', 0])
})

test('an approval and follow-ups get their named props', () => {
  const root = parseOpenUI('root = Stack([BeApproval("改到周五", "把评审挪到周五 10:00", "日程冲突"), BeFollowUps([{label:"起草回复", prompt:"帮我起草回复"}])])') as Component
  const [approval, follow] = root.props.children as Component[]
  assert.deepEqual(approval.props, { title: '改到周五', description: '把评审挪到周五 10:00', context: '日程冲突' })
  assert.deepEqual(follow.props.items, [{ label: '起草回复', prompt: '帮我起草回复' }])
})

test('not OpenUI, or broken OpenUI, is null', () => {
  assert.equal(parseOpenUI('普通的 **Markdown** 回复'), null)
  assert.equal(parseOpenUI('root = Stack([TextContent("没写完'), null)
})

test('chips become the chat\'s citation tokens and links', () => {
  const root = parseOpenUI('root = InlineText(["派给 ", RunChip("12345678-1234-1234-1234-123456789abc"), " 做 ", TaskChip("12345678-1234-1234-1234-123456789abd"), "，见 ", SourceChip("https://x.dev/pr/1", "PR")])')
  assert.ok(isComponent(root ?? undefined))
  assert.equal(inlineMarkdown(root ?? undefined), '派给 [[run:12345678-1234-1234-1234-123456789abc]] 做 [[issue:12345678-1234-1234-1234-123456789abd]]，见 [PR](https://x.dev/pr/1)')
})

test('text of a card: words, question, options; no ids or style words', () => {
  assert.equal(openUIText(parseOpenUI(WELCOME) ?? undefined), '你好，Alex！我是你的 Coordinator。\n想先从哪里开始？\n- 整理收件箱\n- 看看今天的日程')
  assert.equal(openUIText(parseOpenUI('root = Stack([ShadcnBadge("待评审", "secondary"), BeTodoList("计划", [{id:"one", title:"整理需求"}], "suggestion")])') ?? undefined), '待评审\n计划\n整理需求')
})

test('image cards get their named props; their text leaves out the search words', () => {
  const root = parseOpenUI('root = BeCardGrid([a, b])\na = BeImageCard("故宫", "Forbidden City Beijing", "明清皇宫", ["历史"], "怎么逛故宫？")\nb = BeImage("Beijing hutong", "北京胡同", "南锣鼓巷")') as Component
  const [card, figure] = root.props.children as Component[]
  assert.deepEqual(card.props, { title: '故宫', query: 'Forbidden City Beijing', description: '明清皇宫', tags: ['历史'], prompt: '怎么逛故宫？' })
  assert.deepEqual(figure.props, { query: 'Beijing hutong', alt: '北京胡同', caption: '南锣鼓巷' })
  assert.equal(openUIText(root), '故宫\n明清皇宫\n南锣鼓巷')
})

test('image search words: the same rule as the server\'s agentImageQuery', () => {
  for (const query of ['Forbidden City', '  故宫  ', 'a', ' a ', 'x'.repeat(160), 'x'.repeat(161), 'line\nbreak', '<b>', 'see https://a.b', 'HTTP://A.B', 'http:/ok']) {
    assert.equal(isImageQuery(query), agentImageQuery.safeParse(query).success, JSON.stringify(query))
  }
})
