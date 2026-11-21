import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Window } from 'happy-dom'
import type { SuggestionCard } from '@/lib/suggestions/card'

mock.module('@/lib/intl/i18n-client', { namedExports: {
  useLocale: () => 'en',
  useTranslations: () => (key: string, values?: { title?: string }) => values?.title ?? key,
  useMessages: () => ({}),
  useFormatter: () => ({}),
} })

let SentSuggestion: typeof import('./mobile-card')['SentSuggestion']
before(async () => { ({ SentSuggestion } = await import('./mobile-card')) })

const speaker = { name: 'Fixture Bot' }
const card: SuggestionCard = { source: 'github', action: 'review', title: 'Original pull request', actionTitle: 'Review this pull request', url: 'https://example.test/pull/1' }

test('a sent suggestion keeps its source words and link below the card without a second message frame', () => {
  const browser = new Window()
  try {
    const container = browser.document.createElement('div')
    container.innerHTML = renderToStaticMarkup(<SentSuggestion card={card} compact={false} speaker={speaker} />)
    assert.equal(container.children.length, 2)
    assert.equal(container.children[0].getAttribute('data-slot'), 'suggestion-card')
    assert.equal(container.children[1].getAttribute('data-slot'), 'bubble')
    const words = container.querySelector('[data-slot="bubble-content"]')!
    assert.ok(words.textContent.includes('Original pull request'))
    const link = words.querySelector('a')!
    assert.equal(link.getAttribute('href'), card.url)
    assert.equal(link.getAttribute('target'), '_blank')
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer')
    assert.equal(container.querySelector('[data-slot="message"]'), null)
  } finally { browser.close() }
})

test('a sent suggestion with no extra words keeps only its card', () => {
  const browser = new Window()
  try {
    const container = browser.document.createElement('div')
    container.innerHTML = renderToStaticMarkup(<SentSuggestion card={{ ...card, actionTitle: null, url: null }} compact speaker={speaker} />)
    assert.equal(container.children.length, 1)
    assert.equal(container.firstElementChild?.getAttribute('data-slot'), 'suggestion-card')
    assert.equal(container.querySelector('[data-slot="bubble"]'), null)
  } finally { browser.close() }
})
