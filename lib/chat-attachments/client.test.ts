import assert from 'node:assert/strict'
import { test } from 'node:test'
import { uploadChatFile } from './client'

test('a lost completion response retries the same file without uploading or deleting it again', async (t) => {
  const id = '10000000-0000-4000-8000-000000000001'
  const metadata = { id, name: 'notes.md', size: 5, mediaType: 'text/markdown' }
  let puts = 0,
    completions = 0,
    inits = 0,
    deletes = 0
  class Upload {
    upload = { onprogress: undefined }
    status = 200
    responseText = ''
    onload?: () => void
    onerror?: () => void
    open() {}
    setRequestHeader() {}
    abort() {}
    send() {
      puts++
      queueMicrotask(() => this.onload?.())
    }
  }
  const xhrDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest')
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: Upload })
  t.after(() => {
    if (xhrDescriptor) Object.defineProperty(globalThis, 'XMLHttpRequest', xhrDescriptor)
    else Reflect.deleteProperty(globalThis, 'XMLHttpRequest')
  })
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'DELETE') {
      deletes++
      return Response.json({})
    }
    if (String(url).includes('?info')) return Response.json({}, { status: 404 })
    const data = JSON.parse(String(init?.body))
    if (data.operation === 'init') {
      inits++
      return Response.json({ id, uploadUrl: 'https://storage.example/upload', headers: {} })
    }
    completions++
    if (completions === 1) throw new TypeError('Connection lost after server completion')
    assert.equal(data.id, id)
    return Response.json(metadata)
  })
  const file = new File(['hello'], 'notes.md', { type: 'text/markdown' })
  const scope = { kind: 'bot' as const, id }
  await assert.rejects(
    uploadChatFile(file, scope, new AbortController().signal, () => {}),
    /Connection lost/,
  )
  assert.deepEqual(await uploadChatFile(file, scope, new AbortController().signal, () => {}), metadata)
  assert.deepEqual({ puts, completions, inits, deletes }, { puts: 1, completions: 2, inits: 1, deletes: 0 })
})
