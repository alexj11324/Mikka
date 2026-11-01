import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { IntlProvider } from 'next-intl'

const messages = JSON.parse(readFileSync(new URL('../../messages/en.json', import.meta.url), 'utf8'))
mock.module('swr', { exports: { default: () => ({ data: undefined }) } })

let MessageReactions: typeof import('./message-reactions')['MessageReactions']
before(async () => { ({ MessageReactions } = await import('./message-reactions')) })
const render = (node: React.ReactNode) => renderToStaticMarkup(<IntlProvider locale="en" timeZone="UTC" messages={messages}>{node}</IntlProvider>)

test('reactions read as chips: count past one, the person\'s own tinted and named', () => {
  const html = render(<MessageReactions reactions={[{ emoji: '❤️', count: 3, mine: true }, { emoji: '👍', count: 1, mine: false }]} align="end" />)
  assert.match(html, /<ul aria-label="Reactions"[^>]*justify-end/)
  assert.match(html, /<li aria-label="❤️: you and 2 others" data-mine=""[^>]*bg-sidebar-primary\/15/)
  assert.match(html, /<span aria-hidden="true" class="text-xs">3<\/span>/)
  assert.match(html, /<li aria-label="👍: 1 person" class="[^"]*bg-muted/)
  assert.doesNotMatch(html.split('👍: 1 person')[1], /class="text-xs">1</, 'a single reaction shows no count')
})

test('a message nobody reacted to has no reaction row', () => {
  assert.equal(render(<MessageReactions reactions={[]} />), '')
  assert.equal(render(<MessageReactions />), '')
})
