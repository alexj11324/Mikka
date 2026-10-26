import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { agentImageKey, loadAgentImage } from './agent-image-loader'
import { withBasePath } from './base-path'

test('shared Bot image lookup uses the canonical GET path and encodes the complete query', () => {
  const query = '香港 夜景 & q=other/#?'
  const key = agentImageKey(query)
  assert.equal(key, withBasePath(`/api/agent/images?q=${encodeURIComponent(query)}`))
  assert.equal(new URL(key, 'https://mikka.test').searchParams.get('q'), query)
})

test('image loader sends same-origin credentials and returns the saved source metadata', async t => {
  const image = { src: 'https://upload.wikimedia.org/example.jpg', width: 500, height: 300, title: 'Public fixture', source: 'https://commons.wikimedia.org/wiki/File:Fixture.jpg', author: 'Fixture', license: 'CC0' }
  const key = agentImageKey('Public fixture')
  const fetch = mock.method(globalThis, 'fetch', async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    assert.equal(input, key)
    assert.deepEqual(init, { credentials: 'same-origin' })
    return Response.json({ image })
  })
  t.after(() => fetch.mock.restore())
  assert.deepEqual(await loadAgentImage(key), { image })
  assert.equal(fetch.mock.callCount(), 1)
})

test('empty results stay valid and lookup failures reject without echoing upstream details', async t => {
  const fetch = mock.method(globalThis, 'fetch', async () => Response.json({ image: null }))
  t.after(() => fetch.mock.restore())
  assert.deepEqual(await loadAgentImage(agentImageKey('No fixture')), { image: null })
  fetch.mock.mockImplementation(async () => new Response('private upstream detail', { status: 502 }))
  await assert.rejects(loadAgentImage(agentImageKey('Public fixture')), error => error instanceof Error && !error.message.includes('private upstream detail'))
})
