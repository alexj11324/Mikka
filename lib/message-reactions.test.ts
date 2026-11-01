import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchMessageReactions, reactionUrls, REACTION_IDS_PER_REQUEST } from './message-reactions'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

test('reaction reads ask only for stored messages, once each, a hundred per request', () => {
  assert.deepEqual(reactionUrls([]), [])
  assert.deepEqual(reactionUrls([null, undefined, '', '42', 'pending-3']), [])
  assert.deepEqual(reactionUrls([id(2), id(1), id(2)]), [`/api/mobile/reactions?ids=${id(1)},${id(2)}`])
  const many = Array.from({ length: REACTION_IDS_PER_REQUEST + 1 }, (_, n) => id(n))
  const urls = reactionUrls(many)
  assert.equal(urls.length, 2)
  assert.equal(urls[0].split('=')[1].split(',').length, REACTION_IDS_PER_REQUEST)
  assert.equal(urls[1], `/api/mobile/reactions?ids=${id(REACTION_IDS_PER_REQUEST)}`)
})

test('reactions from every page merge; a failed or malformed page reads as none', async () => {
  const pages: Record<string, () => Promise<Response>> = {
    a: async () => Response.json({ reactions: { [id(1)]: [{ emoji: '❤️', count: 2, mine: true }] } }),
    b: async () => Response.json({ reactions: { [id(2)]: [{ emoji: '👍', count: 1, mine: false }] } }),
    down: async () => new Response('nope', { status: 500 }),
    odd: async () => Response.json({ nothing: true }),
    offline: async () => { throw new TypeError('fetch failed') },
  }
  const fetcher = (async (url: string) => pages[url]()) as unknown as typeof fetch
  assert.deepEqual(await fetchMessageReactions(['a', 'down', 'b', 'odd', 'offline'], fetcher), {
    [id(1)]: [{ emoji: '❤️', count: 2, mine: true }],
    [id(2)]: [{ emoji: '👍', count: 1, mine: false }],
  })
  assert.deepEqual(await fetchMessageReactions([], fetcher), {})
})
