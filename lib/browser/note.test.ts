import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withQuote } from '@/lib/artifacts/quote'
import { chatItems } from '@/lib/coordinator/context'
import { normalizeAddress, noteChipText, pageLabel, sameOrigin, splitBrowserNotes, withBrowserNotes, type BrowserNote } from './note'

const ORIGIN = 'https://mikka.example.com'
const element: BrowserNote = { n: 1, kind: 'element', url: `${ORIGIN}/mikka/memories`, label: '按钮 · 删除', note: '删了，刷新又回来了 a < b & "c"', selector: 'body > main > button:nth-of-type(2)', text: '删除' }
const region: BrowserNote = { n: 2, kind: 'region', url: 'https://example.org/pricing?x=1', label: 'example.org/pricing', note: '这里的价格不对', rect: { x: 10, y: 20, width: 200, height: 80, viewportWidth: 560, viewportHeight: 800 } }

test('a note chip reads number · element · note', () => {
  assert.equal(noteChipText(element), '1 · 按钮 · 删除 · 删了，刷新又回来了 a < b & "c"')
})

test('notes ride at the head of the message and come back out whole', () => {
  const message = withBrowserNotes('预览上还是这样，再看看', [element, region])
  assert.match(message, /^<browser-note n="1" kind="element"/)
  assert.deepEqual(splitBrowserNotes(message), { notes: [element, region], text: '预览上还是这样，再看看' })
  assert.equal(withBrowserNotes('plain', []), 'plain')
  assert.deepEqual(splitBrowserNotes('no notes here'), { notes: [], text: 'no notes here' })
  assert.deepEqual(splitBrowserNotes('<browser-note n="0" kind="element" url="x" label="y">z</browser-note>\nrest'), { notes: [], text: '<browser-note n="0" kind="element" url="x" label="y">z</browser-note>\nrest' })
})

test('a message with an artifact quote and notes shows both above the text', () => {
  const quote = { artifactId: '0b6f7c1e-3a54-4a4e-9d55-2f1f0d4f7a10', version: 1, kind: 'text' as const, text: '首页' }
  const raw = withQuote(withBrowserNotes('再看看', [element]), quote)
  const [item] = chatItems([{ position: 1, message: { role: 'user', content: raw }, createdAt: new Date('2026-10-28T00:00:00Z') }])
  assert.equal(item.text, '再看看')
  assert.deepEqual(item.quote, quote)
  assert.deepEqual(item.notes, [element])
})

test('the address bar takes hosts, URLs and app paths, and nothing else', () => {
  assert.equal(normalizeAddress('mikka-git-mik-41.vercel.app/memories', ORIGIN), 'https://mikka-git-mik-41.vercel.app/memories')
  assert.equal(normalizeAddress(' http://example.org ', ORIGIN), 'http://example.org/')
  assert.equal(normalizeAddress('localhost:3000/x', ORIGIN), 'https://localhost:3000/x')
  assert.equal(normalizeAddress('/mikka/memories', ORIGIN), `${ORIGIN}/mikka/memories`)
  for (const bad of ['', 'javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'not a url', 'foo']) assert.equal(normalizeAddress(bad, ORIGIN), null, bad)
})

test('only the app origin counts as reachable', () => {
  assert.equal(sameOrigin(`${ORIGIN}/mikka/x`, ORIGIN), true)
  assert.equal(sameOrigin('https://example.org/', ORIGIN), false)
  assert.equal(sameOrigin('nonsense', ORIGIN), false)
  assert.equal(pageLabel('https://example.org/'), 'example.org')
  assert.equal(pageLabel('https://example.org/a/b?q=1'), 'example.org/a/b')
})
