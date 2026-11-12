import { realpathSync } from 'node:fs'
import http from 'node:http'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { createNodeStreamReader } from '../src/node-stream-reader.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { afterAll, beforeAll, expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const wranglerRequire = createRequire(realpathSync(require.resolve('wrangler/package.json')))
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare')
let runtime, config, directory

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mikka-eve-stream-'))
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('stream-driver.mjs', import.meta.url))],
    format: 'esm', platform: 'browser', external: ['cloudflare:workers','node:*'], bundle: true, write: false,
  })
  config = convertV4MiniflareOptions({ cf: false, host: '127.0.0.1', port: 0, resourcePersistencePath: directory,
    workers: [{ name: 'stream-test', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-22',
      compatibilityFlags: ['nodejs_compat','enable_request_signal'], durableObjects: { STREAM: { className: 'MeasuredStream', useSQLite: true } } }] })
  runtime = new Miniflare(config)
  await runtime.ready
})

afterAll(async () => {
  await runtime?.dispose()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function request(op, run, name, options = {}, params = {}) {
  const url = new URL(op, await runtime.ready)
  url.search = new URLSearchParams({ run, name, ...params }).toString()
  const res = await fetch(url, { ...options, headers: { 'accept-encoding': 'identity', ...options.headers } })
  if (!res.ok) throw new Error(await res.text())
  return res
}

const write = (run, value) => request('/write', run, 'events', { method: 'POST', body: value })
const info = async (op, run, params) => (await request(op, run, 'events', {}, params)).json()

test('a live stream wakes on append and close, remains idle between writes and isolates same-name streams by run', async () => {
  const run = 'run-a'
  await write(run, new Uint8Array([65]))
  const res = await request('/read', run, 'events')
  const reader = res.body.getReader()
  expect(Array.from((await reader.read()).value)).toEqual([65])
  const next = reader.read()
  await delay(80)
  const before = await info('/stats', run)
  expect(before.waiting).toBe(1)
  await delay(350)
  expect(await info('/stats', run)).toEqual(before)
  await write('another-run', new Uint8Array([79]))
  expect(await info('/stats', run)).toEqual(before)
  await write(run, new Uint8Array([66]))
  expect(Array.from((await next).value)).toEqual([66])
  await request('/close', run, 'events', { method: 'POST' })
  expect((await reader.read()).done).toBe(true)
  expect((await info('/chunks','another-run')).data[0].bytes).toEqual([79])
  expect((await info('/list', run))).toEqual(['events'])
  expect((await info('/list', 'unrelated-run'))).toEqual([])
})

test('disconnecting the HTTP reader releases its waiter and other runs remain writable', async () => {
  const run = 'run-cancel'
  await write(run, new Uint8Array([1]))
  const origin = (await runtime.ready).origin
  const read = createNodeStreamReader((url, init) => fetch(new URL(url.pathname + url.search, origin), init))
  // The actual Node HTTP bridge receives the client socket close. Destroying
  // its response stream calls the official World reader's cancel method.
  const server = http.createServer(async (_request, response) => {
    const body = Readable.fromWeb(await read(run, 'events'))
    body.on('error', () => response.destroy())
    response.on('close', () => body.destroy())
    body.pipe(response)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const incoming = http.get('http://127.0.0.1:' + server.address().port, { agent: false })
    const [response] = await once(incoming, 'response')
    const [chunk] = await once(response, 'data')
    expect(Array.from(chunk)).toEqual([1])
    await expect.poll(async () => (await info('/stats', run)).waiting).toBe(1)
    const closed = once(incoming, 'close')
    response.destroy()
    incoming.destroy()
    await closed
    await expect.poll(async () => (await info('/stats', run)).waiting, { timeout: 5000 }).toBe(0)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  await write(run, new Uint8Array([2]))
  await request('/close', run, 'events', { method: 'POST' })
  expect(Array.from(new Uint8Array(await (await request('/read', run, 'events')).arrayBuffer()))).toEqual([1,2])
})

test('an acknowledged subscription release succeeds even when the peer ends the pending read first', async () => {
  const run = 'cancel-races-peer'
  await write(run, new Uint8Array([42]))
  const origin = (await runtime.ready).origin
  const get = createNodeStreamReader(async (url, init) => {
    const response = await fetch(new URL(url.pathname + url.search, origin), init)
    if (init.method === 'DELETE') await delay(150)
    return response
  })
  const reader = (await get(run, 'events')).getReader()
  expect(Array.from((await reader.read()).value)).toEqual([42])
  const next = reader.read()
  await expect(reader.cancel()).resolves.toBeUndefined()
  expect((await next).done).toBe(true)
  expect((await info('/stats', run)).waiting).toBe(0)
  await request('/close', run, 'events', { method: 'POST' })
})

test('zero-byte chunks keep their durable cursor without breaking the byte stream', async () => {
  const run = 'zero'
  await write(run, new Uint8Array())
  await write(run, new Uint8Array([5]))
  await request('/close', run, 'events', { method: 'POST' })
  const response = await request('/read', run, 'events')
  expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([5])
  expect((await info('/chunks', run)).data).toEqual([{ index: 0, bytes: [] }, { index: 1, bytes: [5] }])
})

test('retrying terminal bytes after the first EOF preserves the committed stream', async () => {
  const run = 'terminal-retry'
  await write(run, new Uint8Array([41]))
  await request('/close', run, 'events', { method: 'POST' })
  await write(run, new Uint8Array([41]))
  await request('/close', run, 'events', { method: 'POST' })
  expect(await info('/info', run)).toEqual({ tailIndex: 0, done: true })
  expect((await info('/chunks', run)).data).toEqual([{ index: 0, bytes: [41] }])
  expect(Array.from(new Uint8Array(await (await request('/read', run, 'events')).arrayBuffer()))).toEqual([41])
})

test('a fresh workerd replays persisted bytes at the requested offset and resumes paginated reads', async () => {
  const run = 'run-restart'
  await write(run, new Uint8Array([19]))
  await write(run, new Uint8Array([33, 34]))
  await write(run, new Uint8Array([128]))
  await request('/close', run, 'events', { method: 'POST' })
  await runtime.dispose()
  runtime = new Miniflare(config)
  const page = await info('/chunks', run, { limit: '2' })
  expect(page).toMatchObject({ done: true, hasMore: true, cursor: '2', data: [
    { index: 0, bytes: [19] }, { index: 1, bytes: [33,34] },
  ] })
  const tail = await info('/chunks', run, { limit: '2', cursor: page.cursor })
  expect(tail).toMatchObject({ done: true, hasMore: false, cursor: null, data: [{ index: 2, bytes: [128] }] })
  const fromTail = await request('/read', run, 'events', {}, { start: '-2' })
  expect(Array.from(new Uint8Array(await fromTail.arrayBuffer()))).toEqual([33,34,128])
  expect(await info('/info', run)).toMatchObject({ tailIndex: 2, done: true })
})
