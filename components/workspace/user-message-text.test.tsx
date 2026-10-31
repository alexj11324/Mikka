import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { linkChipLabel, userMessageParts } from '../../lib/user-message-links'

let previewTexts: string[][] = []
mock.module(new URL('./agent-citations.tsx', import.meta.url).href, { namedExports: {
  useLinkPreviews: (texts: string[]) => { previewTexts.push(texts); return {} },
  LinkCitation: ({ url, label }: { url: string; label: string }) => <a data-chip={label} href={url} target="_blank" rel="noopener noreferrer">{label}</a>,
} })
let UserMessageText: typeof import('./user-message-text')['UserMessageText']
before(async () => { ({ UserMessageText } = await import('./user-message-text')) })

test('chip labels drop www. and shorten long paths', () => {
  assert.equal(linkChipLabel('https://vercel.com'), 'vercel.com')
  assert.equal(linkChipLabel('https://www.vercel.com/'), 'vercel.com')
  assert.equal(linkChipLabel('https://github.com/vercel/next.js?tab=readme#top'), 'github.com/vercel/next.js')
  assert.equal(linkChipLabel('https://docs.example.com/guides/getting-started/install'), 'docs.example.com/guides/…')
  assert.equal(linkChipLabel('not a url'), null)
})

test('only http(s) links become chips; the rest stays as written', () => {
  const text = '看看 https://vercel.com/docs。还有 [文档](https://example.com/a) 和 mailto:x@y.z'
  assert.deepEqual(userMessageParts(text), [
    { type: 'text', text: '看看 ' },
    { type: 'link', url: 'https://vercel.com/docs', label: 'vercel.com/docs' },
    { type: 'text', text: '。还有 ' },
    { type: 'link', url: 'https://example.com/a', label: '文档' },
    { type: 'text', text: ' 和 mailto:x@y.z' },
  ])
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
  assert.deepEqual(userMessageParts(`see ${id}`), [{ type: 'text', text: `see ${id}` }])
})

test('a message that is only a link renders just the chip', () => {
  previewTexts = []
  const html = renderToStaticMarkup(<UserMessageText text="https://vercel.com" />)
  assert.equal(html, '<span data-slot="user-message-text"><a data-chip="vercel.com" href="https://vercel.com" target="_blank" rel="noopener noreferrer">vercel.com</a></span>')
  assert.deepEqual(previewTexts, [['https://vercel.com']])
})

test('plain text renders unchanged', () => {
  assert.equal(renderToStaticMarkup(<UserMessageText text={'第一行\n第二行'} />), '<span data-slot="user-message-text">第一行\n第二行</span>')
})
