import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REPLY_QUOTE_MAX, quotable, splitReplyQuote, withReplyQuote } from './chat-quote'
import { replyCopyText } from './chat-copy'

test('a quote heads the message as Markdown quote lines and splits back out', () => {
  const message = withReplyQuote('要整宽还是半宽？', '先把首页截图放大\n\n再换成深色')
  assert.equal(message, '> 先把首页截图放大\n>\n> 再换成深色\n\n要整宽还是半宽？')
  assert.deepEqual(splitReplyQuote(message), { quote: '先把首页截图放大\n\n再换成深色', text: '要整宽还是半宽？' })
})

test('no quote leaves the message as it is', () => {
  assert.equal(withReplyQuote('hello', null), 'hello')
  assert.equal(withReplyQuote('hello', '   '), 'hello')
  assert.deepEqual(splitReplyQuote('hello\n> not at the start'), { quote: null, text: 'hello\n> not at the start' })
})

test('a message that is only a Markdown quote is the person’s own text, not a reply to one', () => {
  assert.deepEqual(splitReplyQuote('> just a quote'), { quote: null, text: '> just a quote' })
})

test('the phone app’s quoted messages read the same way', () => {
  // apps/mobile/components/ui.tsx writes `> ${line}` for every line, blank ones included.
  assert.deepEqual(splitReplyQuote('> 关于你\n> 第二行\n\n好的'), { quote: '关于你\n第二行', text: '好的' })
})

test('a selection is tidied and cut before it is quoted', () => {
  assert.equal(quotable('  第一行  \r\n\n\n\n第二行\n'), '第一行\n\n第二行')
  const long = quotable('字'.repeat(REPLY_QUOTE_MAX + 50))
  assert.equal(long.length, REPLY_QUOTE_MAX + 1)
  assert.ok(long.endsWith('…'))
})

test('复制 on a Markdown reply copies the Markdown as written', () => {
  const markdown = '## 结果\n\n- **首页** 已改好\n\n```ts\nconst a = 1\n```'
  assert.equal(replyCopyText(`${markdown}\n`), markdown)
})

test('复制 on a card copies its prose and words, not the program that draws it', () => {
  const card = '我整理好了：\nroot = BeCard("本周", "三件事", [TextContent("修好登录")])'
  const copied = replyCopyText(card)
  assert.match(copied, /^我整理好了：/)
  assert.match(copied, /修好登录/)
  assert.doesNotMatch(copied, /root =|BeCard\(/)
})
