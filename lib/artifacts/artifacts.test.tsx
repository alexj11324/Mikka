import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { chatItems, eventPrompt } from '@/lib/coordinator/context'
import { ruleTier } from '@/lib/coordinator/triage'
import { markdownDiff, remarkDiff, stripDiffMarkers } from './diff'
import { remarkMarks } from './marks'
import { frameDocument, frameHeaders } from '@mikka/protocol/artifact-frame'
import { artifactFileName, cleanTitle, utf8Bytes } from './limits'
import { splitQuote, withQuote } from './quote'

const ARTIFACT = '0b6f7c1e-3a54-4a4e-9d55-2f1f0d4f7a10'
const at = new Date('2026-10-25T00:00:00Z')

test('a quote rides at the head of the message and comes back out whole', () => {
  const quote = { artifactId: ARTIFACT, version: 2, kind: 'element' as const, text: 'a < b & "c"', label: '卡片 · 首页截图', selector: 'body > main > section:nth-of-type(2)' }
  const text = withQuote('截图放大到整宽。', quote)
  assert.match(text, /^<quote artifact="/)
  assert.deepEqual(splitQuote(text), { quote, text: '截图放大到整宽。' })
  assert.deepEqual(splitQuote('no quote here'), { quote: null, text: 'no quote here' })
  assert.deepEqual(splitQuote('<quote artifact="x" version="0" kind="text">t</quote>\nrest').quote, null)
})

test('an artifact event becomes a card under the next reply, not an event line', () => {
  const event = eventPrompt({ kind: 'artifact_submitted', issueId: null, runId: null, payload: { artifactId: ARTIFACT, version: 2, title: '预览部署验收记录', artifactKind: 'markdown', authorName: 'Mikka Frontend' }, tier: 'result' })
  const items = chatItems([
    { position: 1, createdAt: at, message: { role: 'user', content: '打开 #66 的预览部署' } },
    { position: 2, createdAt: at, message: { role: 'user', content: event } },
    { position: 3, createdAt: at, message: { role: 'assistant', content: `首页截图补好了，验收记录在这里。[[artifact:${ARTIFACT}]]` } },
  ])
  assert.deepEqual(items.map(item => item.from), ['person', 'coordinator'])
  assert.equal(items[1].text, '首页截图补好了，验收记录在这里。')
  assert.deepEqual(items[1].artifacts, [ARTIFACT])
})

test('an artifact with no reply yet shows on its own, and quotes show on the person\'s message', () => {
  const event = eventPrompt({ kind: 'artifact_submitted', issueId: null, runId: null, payload: { artifactId: ARTIFACT, version: 1, title: 'x', artifactKind: 'html', authorName: 'A' } })
  const items = chatItems([
    { position: 1, createdAt: at, message: { role: 'user', content: event } },
    { position: 2, createdAt: at, message: { role: 'user', content: withQuote('改一下', { artifactId: ARTIFACT, version: 1, kind: 'text', text: '核对首页' }) } },
  ])
  assert.deepEqual(items.map(item => [item.from, item.artifacts]), [['coordinator', [ARTIFACT]], ['person', []]])
  assert.equal(items[1].text, '改一下')
  assert.equal(items[1].quote?.text, '核对首页')
})

test('artifact events are results', () => {
  assert.equal(ruleTier({ kind: 'artifact_submitted', payload: {} }), null)
})

const render = (markdown: string) => renderToStaticMarkup(<Markdown remarkPlugins={[remarkGfm, remarkDiff]}>{markdown}</Markdown>)

test('the diff marks dropped and added words in place, inside table cells too', () => {
  const older = '## 结果\n\n| 检查项 | 结果 |\n| --- | --- |\n| 首页截图 | 待补充 |\n\n登录页面已打开；首页截图待补充。'
  const newer = '## 结果\n\n| 检查项 | 结果 |\n| --- | --- |\n| 首页截图 | 已补充 |\n\n登录成功，已跳转到首页；截图已补充，放在本页末尾。'
  const html = render(markdownDiff(older, newer))
  assert.match(html, /<td><del>待补充<\/del><ins>已补充<\/ins><\/td>/)
  assert.match(html, /<p><del>登录页面已打开；首页截图待补充<\/del><ins>登录成功，已跳转到首页；截图已补充，放在本页末尾<\/ins>。<\/p>/)
  assert.doesNotMatch(html, /[\uE000-\uE003]/)
})

test('whole added lines keep their list marker outside the mark', () => {
  const merged = markdownDiff('- 一\n', '- 一\n- 二\n')
  assert.match(merged, /^- 一\n- 二/)
})

test('agent text cannot forge diff marks', () => {
  assert.equal(stripDiffMarkers('abc'), 'abc')
})

test('the frame runs sandboxed with no network, and the quoting script goes first', () => {
  const csp = frameHeaders()['content-security-policy']
  assert.match(csp, /sandbox allow-scripts/)
  assert.doesNotMatch(csp, /allow-same-origin/)
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /connect-src 'none'/)
  const page = frameDocument('<!DOCTYPE html><html><body><script>1</script></body></html>')
  assert.ok(page.startsWith('<!DOCTYPE html><script>'))
  assert.ok(page.indexOf('mikka-frame') < page.indexOf('<script>1</script>'))
})

test('titles and file names stay tidy', () => {
  assert.equal(cleanTitle('  a\n b  '), 'a b')
  assert.equal(artifactFileName('报告/最终: v?', 'markdown', 3), '报告 最终 v v3.md')
  assert.equal(utf8Bytes('中'), 3)
})

test('quoted text is marked even across emphasis and line breaks', () => {
  const html = renderToStaticMarkup(<Markdown remarkPlugins={[remarkGfm, [remarkMarks, [{ text: '核对首页并 保存截图', kind: 'quoted' }, { text: '跳转', kind: 'quoting' }]]]}>{'使用测试账号，核对**首页**并保存截图。\n\n首页跳转'}</Markdown>)
  assert.match(html, /<span data-mark="quoted">核对<\/span><strong><span data-mark="quoted">首页<\/span><\/strong><span data-mark="quoted">并保存截图<\/span>。/)
  assert.match(html, /首页<span data-mark="quoting">跳转<\/span>/)
})
