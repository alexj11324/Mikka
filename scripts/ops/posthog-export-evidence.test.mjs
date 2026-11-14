import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { exportEvidence, main, parseArguments, REPORT_DIRECTORY } from './posthog-export-evidence.mjs'

const key = 'phx_offline_export_fixture'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6B2sAAAAASUVORK5CYII=', 'base64')
const target = { type: 'dashboard', id: 123, timeoutMs: 10000 }
const asset = (overrides = {}) => ({ id: 901, dashboard: 123, insight: null, export_format: 'image/png', has_content: false, exception: null, ...overrides })
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const image = () => new Response(png, { headers: { 'Content-Type': 'image/png' } })

async function temporaryDirectory(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'mikka-posthog-export-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  return cwd
}

async function receipt(cwd, type = 'dashboard', id = 123) {
  return JSON.parse(await readFile(join(cwd, REPORT_DIRECTORY, `posthog-${type}-${id}.receipt.json`), 'utf8'))
}

function recordingFetch(responses) {
  const requests = []
  return {
    requests,
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      assert.ok(url.startsWith('https://us.posthog.com/api/projects/670821/exports/'))
      assert.equal(options.headers.Authorization, `Bearer ${key}`)
      assert.equal(options.redirect, 'manual')
      assert.ok(responses.length, 'unexpected extra network request')
      return responses.shift()
    },
  }
}

test('accepts exactly one numeric saved target, bounded timeout, and no host/format/path options', () => {
  assert.deepEqual(parseArguments(['--dashboard', '123']), { type: 'dashboard', id: 123, timeoutMs: 120000 })
  assert.deepEqual(parseArguments(['--timeout-ms', '300000', '--insight', '456']), { type: 'insight', id: 456, timeoutMs: 300000 })
  assert.deepEqual(parseArguments(['--help']), { help: true })
  for (const args of [[], ['--dashboard', '1', '--insight', '2'], ['--dashboard', '0'], ['--dashboard', '01'],
    ['--dashboard', '../123'], ['--dashboard', '1.2'], ['--dashboard', '9007199254740992'],
    ['--dashboard', '1', '--dashboard', '1'], ['--dashboard', '1', '--timeout-ms', '999'],
    ['--dashboard', '1', '--timeout-ms', '300001'], ['--dashboard', '1', '--host', 'https://example.com'],
    ['--dashboard', '1', '--format', 'text/csv']])
    assert.throws(() => parseArguments(args), error => error.code === 'invalid_arguments')
})

test('one POST, bounded status reads, native PNG and allowlisted receipt; no response metadata leaks', async t => {
  const cwd = await temporaryDirectory(t)
  let clock = Date.UTC(2026, 10, 6)
  const extra = { filename: `private-${key}`, export_context: { path: `https://example.com/?token=${key}` }, secret: key }
  const fake = recordingFetch([json(asset(extra)), json(asset({ ...extra, has_content: true })), image()])
  const result = await exportEvidence(target, { cwd, key, fetchImpl: fake.fetchImpl, now: () => clock, pause: async ms => { clock += ms } })
  assert.equal(fake.requests.length, 3)
  assert.deepEqual(JSON.parse(fake.requests[0].options.body), { dashboard: 123, export_format: 'image/png' })
  assert.deepEqual(fake.requests.map(request => request.options.method), ['POST', 'GET', 'GET'])
  assert.equal(fake.requests[1].url, 'https://us.posthog.com/api/projects/670821/exports/901/')
  assert.equal(fake.requests[2].url, 'https://us.posthog.com/api/projects/670821/exports/901/content/')
  assert.equal(result.status, 'complete')
  assert.equal(result.status_requests, 1)
  assert.equal(result.width, 1)
  assert.equal(result.height, 1)
  assert.equal(result.sha256, createHash('sha256').update(png).digest('hex'))
  assert.deepEqual(await readFile(join(cwd, result.png)), png)
  assert.deepEqual(await receipt(cwd), result)
  assert.doesNotMatch(JSON.stringify(result), /phx_|private-|token=|export_context|filename/)
  assert.deepEqual((await readdir(join(cwd, REPORT_DIRECTORY))).sort(), ['posthog-dashboard-123.png', 'posthog-dashboard-123.receipt.json'])
})

test('an already complete insight is exported without polling or dashboard creation', async t => {
  const cwd = await temporaryDirectory(t)
  const fake = recordingFetch([json(asset({ dashboard: null, insight: 456, has_content: true })), image()])
  const result = await exportEvidence({ type: 'insight', id: 456 }, { cwd, key, fetchImpl: fake.fetchImpl })
  assert.deepEqual(JSON.parse(fake.requests[0].options.body), { insight: 456, export_format: 'image/png' })
  assert.equal(result.status_requests, 0)
  assert.equal((await receipt(cwd, 'insight', 456)).status, 'complete')
})

test('HTTP failure leaves only a safe receipt and CLI error, never raw body or credentials', async t => {
  const cwd = await temporaryDirectory(t)
  const fake = recordingFetch([new Response(JSON.stringify({ detail: key, url: 'https://example.com/?secret=raw-marker' }), { status: 403 })])
  const output = []
  const code = await main(['--dashboard', '123'], { cwd, env: { POSTHOG_PERSONAL_API_KEY: key }, fetchImpl: fake.fetchImpl,
    stdout: { write: text => output.push(text) }, stderr: { write: text => output.push(text) } })
  assert.equal(code, 1)
  assert.equal(fake.requests.length, 1)
  const saved = await receipt(cwd)
  assert.deepEqual(saved.error, { code: 'http_error', phase: 'create', http_status: 403 })
  assert.equal(saved.status, 'failed')
  assert.doesNotMatch(output.join('') + JSON.stringify(saved), /phx_|raw-marker|example\.com|detail|stack/)
  assert.deepEqual(await readdir(join(cwd, REPORT_DIRECTORY)), ['posthog-dashboard-123.receipt.json'])
})

test('server-side export failure does not serialize its exception or attempt a download', async t => {
  const cwd = await temporaryDirectory(t)
  const fake = recordingFetch([json(asset({ exception: `private error ${key}`, has_content: false }))])
  await assert.rejects(exportEvidence(target, { cwd, key, fetchImpl: fake.fetchImpl }), error => error.code === 'export_failed')
  const saved = await receipt(cwd)
  assert.equal(saved.export_id, 901)
  assert.equal(fake.requests.length, 1)
  assert.doesNotMatch(JSON.stringify(saved), /phx_|private error|exception/)
})

test('wrong target, wrong format or changed export id cannot produce an evidence image', async t => {
  for (const responses of [
    [json(asset({ dashboard: 999, has_content: true }))],
    [json(asset({ insight: 456, has_content: true }))],
    [json(asset({ export_format: 'application/pdf', has_content: true }))],
    [json(asset()), json(asset({ id: 902, has_content: true }))],
  ]) {
    const cwd = await temporaryDirectory(t)
    const fake = recordingFetch(responses)
    await assert.rejects(exportEvidence(target, { cwd, key, fetchImpl: fake.fetchImpl, pause: async () => {} }), error => error.code === 'export_target_mismatch')
    assert.ok((await readdir(join(cwd, REPORT_DIRECTORY))).every(name => !name.endsWith('.png')))
  }
})

test('pending export has a total deadline and does not retry the creation', async t => {
  const cwd = await temporaryDirectory(t)
  let clock = 100000
  const fake = recordingFetch([json(asset())])
  await assert.rejects(exportEvidence({ ...target, timeoutMs: 1000 }, {
    cwd, key, fetchImpl: fake.fetchImpl, now: () => clock, pause: async ms => { clock += ms },
  }), error => error.code === 'deadline_exceeded')
  assert.equal(fake.requests.length, 1)
  assert.equal((await receipt(cwd)).status_requests, 0)
})

test('a stalled HTTP request is aborted by the overall deadline', async t => {
  const cwd = await temporaryDirectory(t)
  let signal
  await assert.rejects(exportEvidence({ ...target, timeoutMs: 1000 }, {
    cwd, key, fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}) },
  }), error => error.code === 'deadline_exceeded')
  assert.equal(signal.aborted, true)
  assert.equal((await receipt(cwd)).status, 'failed')
})

test('content redirects are refused without following or revealing the signed URL', async t => {
  const cwd = await temporaryDirectory(t)
  const fake = recordingFetch([json(asset({ has_content: true })), new Response(null, {
    status: 302, headers: { Location: `https://untrusted.example/?credential=${key}` },
  })])
  await assert.rejects(exportEvidence(target, { cwd, key, fetchImpl: fake.fetchImpl }), error => error.code === 'redirect_not_allowed')
  assert.equal(fake.requests.length, 2)
  assert.doesNotMatch(JSON.stringify(await receipt(cwd)), /phx_|untrusted|credential/)
})

test('HTML, invalid PNG, and oversized downloads cannot be saved as screenshots', async t => {
  for (const [response, expected] of [
    [new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }), 'unexpected_content_type'],
    [new Response('not a PNG', { headers: { 'Content-Type': 'image/png' } }), 'invalid_png'],
    [new Response(png, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(33 * 1024 * 1024) } }), 'response_too_large'],
  ]) {
    const cwd = await temporaryDirectory(t)
    const fake = recordingFetch([json(asset({ has_content: true })), response])
    await assert.rejects(exportEvidence(target, { cwd, key, fetchImpl: fake.fetchImpl }), error => error.code === expected)
    assert.ok((await readdir(join(cwd, REPORT_DIRECTORY))).every(name => !name.endsWith('.png')))
  }
})

test('missing/project tokens and network exception text never enter CLI output', async t => {
  const cwd = await temporaryDirectory(t)
  for (const token of [undefined, 'phc_project_fixture', key]) {
    const output = []
    const code = await main(['--dashboard', '123'], { cwd, env: { POSTHOG_PERSONAL_API_KEY: token },
      fetchImpl: async () => { throw new Error(`network failed ${key} https://example.com/?secret=fixture`) },
      stdout: { write: text => output.push(text) }, stderr: { write: text => output.push(text) } })
    assert.equal(code, 1)
    assert.doesNotMatch(output.join(''), /phx_|phc_|secret=|example\.com|stack/)
  }
})

test('an oversized response releases its stream and preserves the refusal reason', async t => {
  const cwd = await temporaryDirectory(t)
  let cancelled = false
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)) },
    cancel() { cancelled = true; return new Promise(() => {}) },
  })
  const fake = recordingFetch([new Response(body)])
  await assert.rejects(exportEvidence({ ...target, timeoutMs: 1000 }, { cwd, key, fetchImpl: fake.fetchImpl }),
    error => error.code === 'response_too_large' && error.phase === 'create')
  assert.equal(cancelled, true)
  assert.equal(body.locked, false)
})
