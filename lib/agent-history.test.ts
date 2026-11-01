import assert from 'node:assert/strict'
import test from 'node:test'
import { chatPreview } from './agent-history'

test('a bot row reads Markdown as its plain text', () => {
  assert.equal(chatPreview('## 结论\n\n**已合并** `#781`，见 [PR](https://github.com/x/y/pull/781)。'), '结论 已合并 #781，见 PR。')
})

test('a bot row reads an OpenUI reply as its first words, never its source', () => {
  // Tab titles are short quoted strings; the old quote scan read from one string's end to the next one's start.
  const tabs = 'root = Stack([tabs])\ntabs = BeTabs([{title: "现象", children: [TextContent("E2B 返回 429 后 dispatch 一直重试。")]}, {title: "日志", children: [BeCodeBlock("retry 1/∞", "text")]}])'
  const preview = chatPreview(tabs)
  assert.ok(preview && !/children|TextContent|\[|\(/.test(preview), preview ?? 'null')
  assert.equal(preview, '现象')
  assert.equal(chatPreview('root = Stack([intro])\nintro = TextContent("发版前有两个阻塞。")'), '发版前有两个阻塞。')
  // Inline chips read as their labels; citation tokens go.
  assert.equal(chatPreview('root = InlineText(["评审在 ", SourceChip("https://github.com/x/y/pull/851", "PR #851"), " 里指出", TaskChip("6f1c2c4e-0d7a-4c1b-9a43-2b6c1f3e9a10")])'), '评审在 PR #851 里指出')
  // Prose the bot wrote above the card comes first; a reply without `root =` is still a card.
  assert.equal(chatPreview('看一下：\nroot = Stack([TextContent("表格")])'), '看一下：')
  assert.equal(chatPreview('Stack([TextContent("没写 root 也是卡片")])'), '没写 root 也是卡片')
})

test('a card that shows no words reads as null, for the row placeholder', () => {
  assert.equal(chatPreview('root = Stack([chart])\nchart = BarChart(["周一", "周二"], [{name: "多提及消息", values: [4, 9]}])'), null)
  assert.equal(chatPreview('root = LineChart(["10/25"], [{name: "失败率", values: [0]}], "%")'), null)
  // A program the parser cannot read never leaks its source either.
  assert.equal(chatPreview('root = Stack([form])\nform = Form("x", Buttons([Button("确认", Action([@ToAssistant("确认")]), "primary")]))'), null)
})
