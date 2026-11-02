import test from 'node:test'
import assert from 'node:assert/strict'
import { botLibraryUrl, deleteLibraryFile, fetchBotLibrary, libraryFileUrl } from './bot-library'

const file = { id: '00000000-0000-4000-8000-000000000001', title: 'Home page timing', kind: 'markdown', version: 2, updatedAt: '2026-11-01T12:00:00.000Z' }

test('a bot\'s library is read from its page; the Coordinator by name', () => {
  assert.equal(botLibraryUrl(null), '/api/mobile/bots/coordinator')
  assert.equal(botLibraryUrl(file.id), `/api/mobile/bots/${file.id}`)
  assert.equal(libraryFileUrl(file.id), `/api/mobile/artifacts/${file.id}`)
})

test('the library reads the page\'s files and fails loudly on anything else', async () => {
  const ok = (async () => Response.json({ threads: [], library: [file] })) as unknown as typeof fetch
  assert.deepEqual(await fetchBotLibrary(null, ok), [file])
  const down = (async () => new Response('', { status: 500 })) as unknown as typeof fetch
  await assert.rejects(fetchBotLibrary(null, down))
  const odd = (async () => Response.json({ threads: [] })) as unknown as typeof fetch
  await assert.rejects(fetchBotLibrary(null, odd))
})

test('deleting sends DELETE for that file and throws unless the server removed it', async () => {
  const calls: { url: string; method?: string }[] = []
  const answer = (status: number) => (async (url: string, init?: RequestInit) => { calls.push({ url, method: init?.method }); return new Response(null, { status }) }) as unknown as typeof fetch
  await deleteLibraryFile(file.id, answer(204))
  assert.deepEqual(calls, [{ url: `/api/mobile/artifacts/${file.id}`, method: 'DELETE' }])
  await assert.rejects(deleteLibraryFile(file.id, answer(404)), /not_found/)
  await assert.rejects(deleteLibraryFile(file.id, answer(405)), /delete_failed/)
})
