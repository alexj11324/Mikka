import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { createElement, type ReactNode } from 'react'
import { createRequire } from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'
const require = createRequire(import.meta.url)

// Render the real OpenUI reply with simple host components; an <img> is a picture.
type Props = { children?: ReactNode; accessibilityLabel?: string; accessibilityState?: { busy?: boolean } }
const View = ({ children, accessibilityState }: Props) => createElement('div', accessibilityState?.busy ? { 'aria-busy': 'true' } : null, children)
const Text = ({ children }: Props) => createElement('span', null, children)
const Image = ({ source, accessibilityLabel }: { source: { uri: string }; accessibilityLabel?: string }) => createElement('img', { src: source.uri, alt: accessibilityLabel })
const stub = (path: string, exports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports: exports })
mock.module('react-native', { namedExports: { View, Image, Pressable: View, TextInput: View, Linking: { openURL: async () => {} }, StyleSheet: { create: (s: unknown) => s } } })
mock.module(require.resolve('lucide-react-native'), { namedExports: { ArrowUpRight: () => null, Check: () => null } })
stub('../components/Text.tsx', { Text })
stub('../components/chat.tsx', { BotBubble: View })
stub('../components/Markdown.tsx', { Markdown: ({ text }: { text: string }) => createElement('p', null, text) })
stub('../components/cards.tsx', { ChatCard: View, CardButton: ({ label }: { label: string }) => createElement('button', null, label), cardText: {} })
stub('../lib/web.ts', { openOnWeb: async () => {} })
stub('../lib/theme.ts', { colors: {}, font: 'System' })

const asked: string[] = []
let lookup: (query: string) => Promise<unknown> = async () => { throw new Error('unset') }
stub('../lib/api.ts', { api: (path: string) => { const query = new URL(path, 'http://x').searchParams.get('q') ?? ''; asked.push(query); return lookup(query) }, ApiError: class extends Error {} })

const { OpenUIReply } = await import('../components/OpenUI')
const { findImage } = await import('../lib/images')

const image = (title: string) => ({ src: `https://upload.wikimedia.org/${title}.jpg`, width: 500, height: 281, title: `${title}.jpg`, source: `https://commons.wikimedia.org/wiki/File:${title}.jpg`, author: 'Someone', license: 'CC BY-SA 4.0' })
const reply = (text: string) => renderToStaticMarkup(createElement(OpenUIReply, { text, live: true, answer: async () => true, webPath: '/', sources: {}, onOpen: () => {} }))

const BEIJING = `root = Stack([TextContent("北京值得一去的地方："), grid])
grid = BeCardGrid([palace, wall])
palace = BeImageCard("故宫", "Forbidden City Beijing", "明清两代皇宫，建议预留半天。", ["历史", "建筑"], "故宫怎么安排半天路线？")
wall = BeImageCard("八达岭长城", "Badaling Great Wall", "离市区最近的长城段落。")`

test('a recommendation grid draws each card: picture, title, description, tags, 继续了解', async () => {
  lookup = async query => ({ image: query === 'Forbidden City Beijing' ? image('Palace') : image('Wall') })
  await Promise.all([findImage('Forbidden City Beijing'), findImage('Badaling Great Wall')])
  const html = reply(BEIJING)
  assert.ok(!html.includes('在网页上打开'))
  assert.ok(html.includes('<img src="https://upload.wikimedia.org/Palace.jpg" alt="故宫"/>'))
  assert.ok(html.includes('<img src="https://upload.wikimedia.org/Wall.jpg" alt="八达岭长城"/>'))
  const order = ['Palace.jpg', '图片来源与许可', '故宫', '明清两代皇宫', '历史', '建筑', '<button>继续了解</button>', 'Wall.jpg', '八达岭长城']
  order.reduce((at, part) => { const next = html.indexOf(part, at); assert.ok(next > at, `${part} after ${at}`); return next }, -1)
  // The second card has no prompt, so only one button.
  assert.equal(html.match(/<button>/g)?.length, 1)
  assert.ok(!html.includes('Forbidden City'), 'search words are not shown')
})

test('while looking, a grey placeholder holds the picture\'s place', () => {
  const html = reply('root = BeImageCard("颐和园", "Summer Palace Beijing", "皇家园林。")')
  assert.ok(html.includes('aria-busy="true"'))
  assert.ok(!html.includes('<img'))
  assert.ok(html.includes('颐和园'))
})

test('a failed lookup leaves the card without a picture', async () => {
  lookup = async () => { throw new Error('http502') }
  assert.equal(await findImage('Temple of Heaven'), null)
  const html = reply('root = BeImageCard("天坛", "Temple of Heaven", "明清祭天建筑群。")')
  assert.ok(!html.includes('<img'))
  assert.ok(!html.includes('aria-busy'))
  assert.ok(!html.includes('图片来源与许可'))
  assert.ok(html.includes('天坛') && html.includes('明清祭天建筑群。'))
})

test('words the server would refuse are never looked up', async () => {
  const before = asked.length
  assert.equal(await findImage('https://example.com/a.jpg'), null)
  assert.equal(await findImage('a'), null)
  assert.equal(asked.length, before)
})

test('a single illustration shows its caption and credit', async () => {
  lookup = async () => ({ image: image('Hutong') })
  await findImage('Beijing hutong')
  const html = reply('root = BeImage("Beijing hutong", "北京胡同", "南锣鼓巷附近的胡同")')
  assert.ok(html.includes('<img src="https://upload.wikimedia.org/Hutong.jpg" alt="北京胡同"/>'))
  assert.ok(html.includes('南锣鼓巷附近的胡同'))
  assert.ok(html.includes('Wikimedia Commons · Hutong.jpg · Someone · CC BY-SA 4.0'))
})
