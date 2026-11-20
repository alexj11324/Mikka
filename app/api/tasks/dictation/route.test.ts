import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

class FakeChatFileError extends Error { constructor(readonly code: string) { super(code) } }
class FakeWorkspaceError extends Error {}
let signedIn = true
let tokenWorkspaceId: string | undefined
const transcribed: { userId: string; workspaceId: string; size: number }[] = []
let failWith: Error | null = null

mock.module('@/lib/api-auth', { namedExports: {
  auth: { api: { getSession: async () => signedIn ? { user: { id: 'user-1' }, tokenWorkspaceId } : null } },
  apiWorkspaceAllowed: (session: { tokenWorkspaceId?: string }, workspaceId: string) => !session.tokenWorkspaceId || session.tokenWorkspaceId === workspaceId,
} })
mock.module('@/lib/mobile-api', { namedExports: { writeAllowed: () => true } })
mock.module('@/lib/chat-attachments/extract', { namedExports: { ChatFileError: FakeChatFileError } })
mock.module('@/lib/workspace-access', { namedExports: { WorkspaceError: FakeWorkspaceError, loadWorkspaceContext: async () => ({ workspace: { id: 'ws-1' } }) } })
mock.module('@/lib/chat-attachments/transcribe', { namedExports: { transcribeChatAudio: async (userId: string, workspaceId: string, audio: Uint8Array) => {
  if (failWith) throw failWith
  transcribed.push({ userId, workspaceId, size: audio.byteLength })
  return 'Fix the login page'
} } })
const { POST } = await import('./route')

const send = (body: BodyInit | null, type = 'audio/webm') => POST(new Request('http://localhost/mikka/api/tasks/dictation', { method: 'POST', body, headers: { 'content-type': type } }))

test('dictation transcribes the audio in the caller workspace and returns only the text', async () => {
  const response = await send(new Uint8Array([1, 2, 3]))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { text: 'Fix the login page' })
  assert.deepEqual(transcribed, [{ userId: 'user-1', workspaceId: 'ws-1', size: 3 }])
})

test('dictation refuses a signed-out caller, a non-audio body and an oversized recording', async () => {
  signedIn = false
  assert.equal((await send(new Uint8Array([1]))).status, 401)
  signedIn = true
  assert.equal((await send('text', 'text/plain')).status, 400)
  assert.equal((await send(new Uint8Array(10 * 1024 * 1024 + 1))).status, 413)
})

test('dictation without an OpenAI transcription key names the missing key', async () => {
  failWith = new FakeChatFileError('audioKeyRequired')
  const response = await send(new Uint8Array([1]))
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'audioKeyRequired' })
  failWith = null
})

test('a token scoped to another workspace cannot transcribe in this one', async () => {
  transcribed.length = 0
  tokenWorkspaceId = 'ws-other'
  const response = await send(new Uint8Array([1]))
  assert.equal(response.status, 404)
  assert.deepEqual(transcribed, [])
  tokenWorkspaceId = 'ws-1'
  assert.equal((await send(new Uint8Array([1]))).status, 200)
  tokenWorkspaceId = undefined
})
