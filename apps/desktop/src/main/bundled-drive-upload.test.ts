import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { type AddressInfo } from 'node:net'
import test from 'node:test'
import { bundledProtocol } from './bundled-protocol'
import { RENDERER_URL } from './bundled-policy'
import { DRIVE_MAX_FILE_BYTES } from '../../../../lib/drive/contract'

const uploadRoute = '/api/drive/volumes/vol_01ARZ3NDEKTSV4RRFFQ69G5FAV/blobs'

function uploadRequest(path: string, size: number, declaredSize?: number): Request {
  const chunk = new Uint8Array(1024 * 1024).fill(42)
  let remaining = size
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!remaining) { controller.close(); return }
      const length = Math.min(chunk.length, remaining)
      controller.enqueue(chunk.subarray(0, length))
      remaining -= length
    },
  })
  return new Request(RENDERER_URL + path, {
    method: 'POST', body, duplex: 'half',
    headers: declaredSize === undefined ? {} : { 'content-length': String(declaredSize) },
  } as RequestInit & { duplex: 'half' })
}

test('bundled personal Files forwards the full Drive upload limit and bounds declared and streamed bytes', async t => {
  const received: { path: string | undefined; bytes: number; digest: string }[] = []
  const backend = createServer(async (request, response) => {
    let bytes = 0
    const hash = createHash('sha256')
    for await (const chunk of request) { bytes += chunk.length; hash.update(chunk) }
    received.push({ path: request.url, bytes, digest: hash.digest('hex') })
    response.writeHead(201).end()
  })
  backend.listen(0, '127.0.0.1')
  await once(backend, 'listening')
  t.after(() => new Promise<void>(resolve => backend.close(() => resolve())))
  const origin = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`
  const handle = bundledProtocol('', { request: (path, init) => fetch(new URL(path, origin), init) })
  assert.equal((await handle(uploadRequest(uploadRoute, DRIVE_MAX_FILE_BYTES))).status, 201)
  for (const request of [
    uploadRequest(uploadRoute, 1, DRIVE_MAX_FILE_BYTES + 1),
    uploadRequest(uploadRoute, DRIVE_MAX_FILE_BYTES + 1),
  ]) {
    const response = await handle(request)
    assert.equal(response.status, 413)
    assert.deepEqual(await response.json(), { error: 'drive_limit_exceeded' })
  }
  assert.equal((await handle(uploadRequest('/api/desktop/rpc', 32 * 1024 * 1024 + 1))).status, 413)
  const expectedHash = createHash('sha256')
  const chunk = new Uint8Array(1024 * 1024).fill(42)
  for (let i = 0; i < DRIVE_MAX_FILE_BYTES; i += chunk.length) expectedHash.update(chunk)
  assert.deepEqual(received, [{ path: uploadRoute, bytes: DRIVE_MAX_FILE_BYTES, digest: expectedHash.digest('hex') }])
})
