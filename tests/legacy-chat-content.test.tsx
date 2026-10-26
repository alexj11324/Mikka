import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { legacyChatContent } from '../lib/legacy-chat-content'
import { LegacyReplyContent } from '../components/workspace/legacy-reply-content'

export const archivedControls = `root = Stack([TextContent("Readable saved answer"), BeButton("继续细化", "never execute this prompt", "outline"), ShadcnAccordion([{title:"First section",content:"First saved content"},{title:"Second section",content:"Second saved content"}]), ShadcnTabs([{title:"First tab",children:[TextContent("First pane")]},{title:"Second tab",children:[TextContent("Second pane")] }]), ComputerCard("archived-bot", "archived-run", "Saved computer task", "approval", "Saved bot", "Saved thread")])`

test('Every Accordion section and Tab pane remains readable without active controls', () => {
  const result = legacyChatContent(archivedControls)
  assert.equal(result.format, 'markdown')
  for (const text of ['Readable saved answer', 'First saved content', 'Second saved content', 'First pane', 'Second pane', '继续细化', 'Saved computer task', 'Saved thread']) assert.ok(result.text.includes(text), text)
  assert.doesNotMatch(result.text, /never execute|archived-bot|archived-run/)
  const html = renderToStaticMarkup(<LegacyReplyContent response={archivedControls} />)
  assert.match(html, /Second saved content/)
  assert.match(html, /Second pane/)
  assert.match(html, /Saved computer task/)
  assert.doesNotMatch(html, /<button|<input|<form|<iframe|<canvas|\sinert|aria-hidden/)
})

test('Saved Markdown and source URLs are text, not live image or navigation requests', () => {
  const response = 'Saved **body** [source](https://www.iana.org/) ![caption](https://example.org/image.png) <script>execute()</script>'
  const html = renderToStaticMarkup(<LegacyReplyContent response={response} />)
  assert.match(html, /<strong>body<\/strong>/)
  assert.match(html, /https:\/\/www.iana.org/)
  assert.match(html, /caption/)
  assert.doesNotMatch(html, /<img|<a\s|<script|\sinert/)
})

test('Malformed source remains visible and escaped rather than silently disappearing or executing', () => {
  const response = 'root = MissingComponent("<script>execute()</script>")'
  assert.deepEqual(legacyChatContent(response), { format: 'source', text: response })
  const html = renderToStaticMarkup(<LegacyReplyContent response={response} />)
  assert.match(html, /MissingComponent/)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<script|\sinert/)
})

test('Repeated saved content, code and table data retain their text', () => {
  const response = 'root = Stack([body,body,BeCodeBlock("const saved = true", "js"),ShadcnTable(["Name","Value"],[["saved","42"]])])\nbody = TextContent("Repeated saved text")'
  const result = legacyChatContent(response)
  assert.equal(result.text.split('Repeated saved text').length - 1, 2)
  const html = renderToStaticMarkup(<LegacyReplyContent response={response} />)
  assert.match(html, /const saved = true/)
  assert.match(html, /<table>/)
  assert.match(html, /<td>42<\/td>/)
})
