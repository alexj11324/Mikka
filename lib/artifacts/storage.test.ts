import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { artifactStorage, deleteArtifactObject, getArtifactObjectBytes, presignArtifactGet, putArtifactObject } from './storage'

test('cloud production requires object storage on an explicit deployment stage', t => {
  const keys = ['MIKKA_DEPLOYMENT_STAGE', 'VERCEL_ENV', 'MIKKA_EDITION', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_REGION', 'R2_ACCOUNT_ID', 'CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const
  const saved = keys.map(key => process.env[key])
  keys.forEach(key => { delete process.env[key] })
  t.after(() => keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index] }))
  process.env.MIKKA_EDITION = 'cloud'
  process.env.MIKKA_DEPLOYMENT_STAGE = 'production'
  process.env.VERCEL_ENV = 'preview'
  assert.throws(() => artifactStorage(), /Object storage is not configured/)
  process.env.MIKKA_DEPLOYMENT_STAGE = 'preview'
  process.env.VERCEL_ENV = 'production'
  assert.equal(artifactStorage(), 'inline')
  process.env.MIKKA_DEPLOYMENT_STAGE = 'prod'
  assert.throws(() => artifactStorage(), /MIKKA_DEPLOYMENT_STAGE_INVALID/)
})

test('signed uploads retain exact byte length when a fetch adapter streams the body', async (t) => {
  const keys = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const
  const previous = keys.map((key) => process.env[key])
  for (const key of keys) process.env[key] = 'isolated-storage-fixture'
  t.after(() => keys.forEach((key, i) => {
    if (previous[i] === undefined) delete process.env[key]
    else process.env[key] = previous[i]
  }))
  const received: Array<{ size: number; hash: string }> = []
  const server = createServer(async (request, response) => {
    if (!request.headers['content-length']) {
      request.resume()
      response.writeHead(411).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const bytes = Buffer.concat(chunks)
    assert.equal(request.headers['content-length'], String(bytes.length))
    assert.equal(request.headers['if-none-match'], '*')
    received.push({ size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') })
    response.writeHead(200).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address() as { port: number }
  const fetchImpl = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const signed = new Request(input, init)
    // Framework fetch adapters can turn a buffered Request into a stream.
    // A stream loses the body's implicit length unless the header is explicit.
    return fetchImpl(new Request(`http://127.0.0.1:${address.port}/object`, {
      method: signed.method, headers: signed.headers, body: signed.body,
      duplex: 'half',
    } as RequestInit))
  })
  const fixtures = [Buffer.from('中文 Markdown 📎'), Buffer.alloc(6 * 1024 * 1024, 137)]
  for (const bytes of fixtures) {
    await putArtifactObject('fixture', bytes, 'application/octet-stream')
  }
  await putArtifactObject('unicode', '中文 Markdown 📎', 'text/plain')
  assert.deepEqual(received, [...fixtures, fixtures[0]].map((bytes) => ({
    size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex'),
  })))
})

test('S3 configuration signs a private bucket, round-trips bytes and keeps community files inline when absent', async t => {
  const names = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_REGION', 'R2_ACCOUNT_ID', 'CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'MIKKA_EDITION', 'VERCEL_ENV', 'NODE_ENV'] as const
  const previous = names.map(key => process.env[key])
  for (const key of names) delete process.env[key]
  t.after(() => names.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] }))
  process.env.VERCEL_ENV = 'production'
  assert.equal(artifactStorage(), 'inline')
  process.env.MIKKA_EDITION = 'cloud'
  assert.throws(() => artifactStorage(), /Object storage is not configured/)
  Object.assign(process.env, { NODE_ENV: 'production', VERCEL_ENV: 'preview' })
  assert.equal(artifactStorage(), 'inline', 'Vercel preview builds can use inline storage')
  delete process.env.VERCEL_ENV
  assert.throws(() => artifactStorage(), /Object storage is not configured/, 'a hosted Node production runtime requires the bucket')
  process.env.MIKKA_EDITION = 'community'
  assert.equal(artifactStorage(), 'inline', 'self-hosted Node production can keep files in PostgreSQL')
  let stored = Buffer.alloc(0)
  const server = createServer(async (request, response) => {
    assert.equal(request.url, '/private-bucket/folder/test%20file')
    assert.match(request.headers.authorization ?? '', /\/eu-west-1\/s3\/aws4_request/)
    if (request.method === 'PUT') {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      stored = Buffer.concat(chunks); response.end()
    } else if (request.method === 'DELETE') { stored = Buffer.alloc(0); response.end() }
    else response.end(stored)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  Object.assign(process.env, { S3_ENDPOINT: `http://127.0.0.1:${(server.address() as { port: number }).port}`, S3_BUCKET: 'private-bucket', S3_ACCESS_KEY_ID: 'fixture', S3_SECRET_ACCESS_KEY: 'fixture-secret', S3_REGION: 'eu-west-1' })
  assert.equal(artifactStorage(), 'r2', 'the existing persisted object-store discriminator is retained')
  const body = Buffer.from('Self-hosted 文件')
  await putArtifactObject('folder/test file', body, 'text/plain')
  assert.deepEqual(await getArtifactObjectBytes('folder/test file'), new Uint8Array(body))
  const signed = new URL(await presignArtifactGet('folder/test file', 'text/plain', 'inline'))
  assert.equal(signed.pathname, '/private-bucket/folder/test%20file')
  assert.ok(signed.searchParams.has('X-Amz-Signature'))
  assert.match(signed.searchParams.get('X-Amz-Credential') ?? '', /\/eu-west-1\/s3\/aws4_request/)
  await deleteArtifactObject('folder/test file')
  assert.equal(stored.length, 0)
  delete process.env.S3_SECRET_ACCESS_KEY
  assert.throws(() => artifactStorage(), /S3 configuration is incomplete/, 'a partial bucket configuration never silently stores data elsewhere')
})
