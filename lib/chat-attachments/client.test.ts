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

test('same-origin parts remain below the platform body limit and a lost part response retries the same bytes', async (t) => {
  const id = '20000000-0000-4000-8000-000000000001'
  const chunkSize = 3 * 1024 * 1024
  const file = new File([new Uint8Array(chunkSize + 17).fill(42)], 'image.png', { type: 'image/png' })
  const metadata = { id, name: file.name, size: file.size, mediaType: file.type }
  const parts: { url: string; body: Blob }[] = []
  let lost = true,
    inits = 0
  class Upload {
    upload = { onprogress: undefined }
    status = 200
    responseText = '{}'
    onload?: () => void
    onerror?: () => void
    url = ''
    open(method: string, url: string) {
      assert.equal(method, 'POST')
      this.url = url
    }
    setRequestHeader() {}
    abort() {}
    send(body: Blob) {
      parts.push({ url: this.url, body })
      queueMicrotask(() => {
        if (lost) {
          lost = false
          this.onerror?.()
        } else this.onload?.()
      })
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest')
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: Upload })
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'XMLHttpRequest', descriptor)
    else Reflect.deleteProperty(globalThis, 'XMLHttpRequest')
  })
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.notEqual(init?.method, 'DELETE', 'uncertain responses preserve their immutable upload')
    if (String(url).includes('?info')) return Response.json({}, { status: 404 })
    const body = JSON.parse(String(init?.body))
    if (body.operation === 'init') {
      inits++
      return Response.json({ id, chunkSize })
    }
    assert.equal(body.id, id)
    return Response.json(metadata)
  })
  const scope = { kind: 'group' as const, id }
  await assert.rejects(
    uploadChatFile(file, scope, new AbortController().signal, () => {}),
    /unavailable/,
  )
  assert.deepEqual(await uploadChatFile(file, scope, new AbortController().signal, () => {}), metadata)
  assert.equal(inits, 1)
  assert.deepEqual(
    parts.map((part) => part.body.size),
    [chunkSize, chunkSize, 17],
  )
  assert.deepEqual(
    parts.map((part) => new URL(part.url, 'https://mikka.invalid').searchParams.get('part')),
    ['0', '0', '1'],
  )
  assert.deepEqual(
    Buffer.from(await parts[0].body.arrayBuffer()),
    Buffer.from(await parts[1].body.arrayBuffer()),
  )
})
