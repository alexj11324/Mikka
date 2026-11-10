import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { BYOS_IMAGES, pullPinnedByosImage } from './test-subscription-worker-pull.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const pg = createRequire(import.meta.url).resolve('pg')
const postgres = 'postgres:17-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb'
const golang = 'golang:1.26.10-bookworm@sha256:632dff7351799a5a9954a48dc06670ade72ee44e8c351cdc0e5a57af2fea21af'
const registry502 = 'docker: Error response from daemon: Get "https://registry-1.docker.io/v2/library/postgres/manifests/sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb": received unexpected HTTP status: 502 Bad Gateway\n'

function runWorker(mode) {
  const directory = mkdtempSync(join(tmpdir(), 'byos-pull-contract-'))
  const events = join(directory, 'events.jsonl')
  const preload = join(directory, 'preload.mjs')
  writeFileSync(preload, `
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { appendFileSync } from 'node:fs';
const events = ${JSON.stringify(events)}, mode = ${JSON.stringify(mode)};
const record = value => appendFileSync(events, JSON.stringify(value) + '\\n');
const pulled = new Set(), pulls = new Map();
mock.module('node:child_process', { namedExports: { spawn(command, args, options) {
  record({ command: command === process.execPath ? 'node' : command,
    args: args.map(arg => /^(?:POSTGRES_PASSWORD|MIKKA_BYOS_TEST_DATABASE_URL)=/.test(arg) ? arg.split('=')[0] + '=[isolated fixture]' : arg) });
  const child = new EventEmitter(); child.stderr = new PassThrough(); child.stdout = new PassThrough();
  queueMicrotask(() => {
    let code = 0, stderr = '';
    if (command === 'docker' && args[0] === 'pull') {
      const image = args[1], n = (pulls.get(image) ?? 0) + 1; pulls.set(image, n);
      if (mode === 'transient' && image.startsWith('postgres:') && n === 1) { code = 1; stderr = ${JSON.stringify(registry502)}; }
      else pulled.add(image);
    } else if (command === 'docker' && args[0] === 'run') {
      const image = args.find(arg => /^(postgres|golang):/.test(arg));
      if (!pulled.has(image)) { code = 125; stderr = ${JSON.stringify(registry502)}; }
      else if (!args.includes('--pull=never')) { code = 124; stderr = 'test requires acquisition to finish before container execution\\n'; }
      else if (mode === 'worker-failure' && image.startsWith('golang:')) { code = 17; stderr = 'synthetic Go business test failed\\n'; }
    } else if (mode === 'application-failure' && command === process.execPath && args.includes('--test')) {
      code = 19; stderr = 'synthetic application business test failed\\n';
    }
    if (options.stdio[2] === 'inherit') process.stderr.write(stderr); else child.stderr.end(stderr);
    child.emit('exit', code, null); child.emit('close', code, null);
  });
  return child;
} } });
mock.module('node:timers/promises', { namedExports: { setTimeout: async ms => { record({ delay: ms }); } } });
mock.module('node:net', { namedExports: { createServer: () => ({
  listen(_port, _host, callback) { queueMicrotask(callback); },
  address() { return { port: 32123 }; }, close(callback) { queueMicrotask(callback); }
}) } });
mock.module(${JSON.stringify(pg)}, { namedExports: { Pool: class {
  async query() { return { rows: [{ migrations: 264 }] }; } async end() {}
} } });
`, { mode: 0o600 })
  try {
    let status = 0, stderr = ''
    try {
      execFileSync(process.execPath, ['--experimental-test-module-mocks', '--import', preload, 'scripts/test-subscription-worker.mjs'],
        { cwd: root, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C.UTF-8' } })
    } catch (error) {
      status = error.status; stderr = String(error.stderr)
    }
    return { status, stderr, events: readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line)) }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('actual worker runner acquires fixed images before starting containers after a registry 502', () => {
  const result = runWorker('transient')
  assert.equal(result.status, 0, result.stderr)
  const pulls = result.events.filter(event => event.command === 'docker' && event.args[0] === 'pull')
  assert.deepEqual(pulls.map(event => event.args[1]), [postgres, postgres, golang])
  const runs = result.events.filter(event => event.command === 'docker' && event.args[0] === 'run')
  assert.equal(runs.length, 2)
  assert.ok(runs.every(event => event.args.includes('--pull=never')))
  assert.equal(result.events.filter(event => event.command === 'node' && event.args.includes('--test')).length, 1)
  assert.equal(result.events.filter(event => event.delay).length, 1)
})

for (const [mode, expectedExit] of [['worker-failure', 17], ['application-failure', 19]]) {
  test(`actual ${mode} is never retried, and cannot restart image setup`, () => {
    const result = runWorker(mode)
    assert.equal(result.status, 1)
    assert.match(result.stderr, new RegExp(`BYOS test subprocess exited ${expectedExit}`))
    assert.deepEqual(result.events.filter(event => event.command === 'docker' && event.args[0] === 'pull').map(event => event.args[1]), [postgres, golang])
    assert.equal(result.events.filter(event => event.command === 'docker' && event.args[0] === 'run').length, 2)
    assert.equal(result.events.filter(event => event.command === 'node' && event.args.includes('--test')).length, mode === 'worker-failure' ? 0 : 1)
    assert.equal(result.events.filter(event => event.delay).length, 0)
  })
}

function fixture(outcomes) {
  const calls = [], waits = [], writes = []
  let position = 0
  return {
    calls, waits, writes,
    run: (image = postgres) => pullPinnedByosImage(image, {
      env: { PATH: '/synthetic-test/bin', LANG: 'C.UTF-8' },
      spawnImpl(command, args, options) {
        calls.push({ command, args, env: options.env })
        const child = new EventEmitter(); child.stderr = new PassThrough()
        queueMicrotask(() => {
          const outcome = outcomes[position++] ?? outcomes.at(-1)
          if (outcome.stderr) child.stderr.write(outcome.stderr)
          if (outcome.error) child.emit('error', outcome.error)
          child.emit('close', outcome.code ?? 0, outcome.signal ?? null)
        })
        return child
      },
      sleep: async ms => { waits.push(ms) },
      stderr: { write: chunk => { writes.push(String(chunk)) } },
    }),
  }
}

test('a successful acquisition keeps both original image identities and needs no retry', async () => {
  assert.deepEqual(BYOS_IMAGES, { postgres, golang })
  const f = fixture([{ code: 0 }])
  await f.run()
  assert.deepEqual(f.calls, [{ command: 'docker', args: ['pull', postgres], env: { PATH: '/synthetic-test/bin', LANG: 'C.UTF-8' } }])
  assert.deepEqual(f.waits, [])
})

for (const [detail, stderr] of [
  ['registry_http_502', registry502],
  ['registry_http_503', 'unexpected status from HEAD request to https://registry-1.docker.io/v2/library/postgres/manifests/sha256:fixed: 503 Service Unavailable\n'],
  ['registry_http_429', 'toomanyrequests: You have reached your unauthenticated pull rate limit\n'],
  ['registry_timeout', 'net/http: TLS handshake timeout\n'],
  ['registry_timeout', 'Get "https://registry-1.docker.io/v2/": context deadline exceeded (Client.Timeout exceeded while awaiting headers)\n'],
  ['registry_timeout', 'dial tcp 192.0.2.1:443: i/o timeout\n'],
]) {
  test(`only classified registry acquisition ${detail} retries and preserves stderr`, async () => {
    const f = fixture([{ code: 1, stderr }, { code: 0 }])
    await f.run()
    assert.equal(f.calls.length, 2)
    assert.ok(f.calls.every(call => call.command === 'docker' && call.args[0] === 'pull' && call.args[1] === postgres))
    assert.deepEqual(f.waits, [1000])
    assert.equal(f.writes[0], stderr)
    assert.ok(f.writes[1].includes(detail))
  })
}

test('persistent registry failures stop after three acquisitions with bounded backoff', async () => {
  const f = fixture([{ code: 1, stderr: registry502 }])
  await assert.rejects(f.run(), error => error.code === 'BYOS_IMAGE_PULL_FAILED' && error.detail === 'registry_http_502')
  assert.equal(f.calls.length, 3)
  assert.deepEqual(f.waits, [1000, 3000])
  assert.equal(f.writes.filter(value => value === registry502).length, 3)
})

for (const [name, stderr] of [
  ['authorization', 'unauthorized: authentication required\n'],
  ['missing manifest', 'manifest unknown: manifest unknown\n'],
  ['integrity', 'filesystem layer verification failed\n'],
  ['commit digest mismatch after a transport message', registry502 + 'failed commit: unexpected commit digest sha256:bad, expected sha256:fixed: failed precondition\n'],
  ['daemon unavailable', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n'],
  ['certificate', 'x509: certificate signed by unknown authority\n'],
  ['unclassified HTTP status', 'received unexpected HTTP status: 500 Internal Server Error\n'],
  ['unclassified transport error', 'unexpected EOF\n'],
]) {
  test(`${name} stops without retrying or swallowing stderr`, async () => {
    const f = fixture([{ code: 1, stderr }, { code: 0 }])
    await assert.rejects(f.run(), error => error.code === 'BYOS_IMAGE_PULL_FAILED')
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.waits, [])
    assert.deepEqual(f.writes, [stderr])
  })
}

test('interrupted and oversized diagnostics cannot be mistaken for retryable failures', async () => {
  for (const outcome of [
    { code: null, signal: 'SIGTERM', stderr: registry502 },
    { code: 1, stderr: 'x'.repeat(65537) + registry502 },
  ]) {
    const f = fixture([outcome])
    await assert.rejects(f.run(), error => ['interrupted', 'unknown'].includes(error.detail))
    assert.equal(f.calls.length, 1); assert.deepEqual(f.waits, [])
    assert.equal(f.writes[0], outcome.stderr)
  }
})

test('spawn failure retains its cause and cannot trigger registry retries', async () => {
  const cause = Object.assign(new Error('synthetic executable unavailable'), { code: 'ENOENT' })
  const f = fixture([{ error: cause, code: 1 }])
  await assert.rejects(f.run(), error => error.detail === 'spawn' && error.cause === cause)
  assert.equal(f.calls.length, 1); assert.deepEqual(f.waits, [])
})

test('mutable tags, different digests and other registries fail before Docker runs', async () => {
  for (const image of ['postgres:17-alpine', postgres.replace(/.$/, '0'), 'mirror.example/library/' + postgres, golang.replace('1.26.10-bookworm', 'latest')]) {
    const f = fixture([{ code: 0 }])
    await assert.rejects(f.run(image), error => error.detail === 'unpinned_image')
    assert.deepEqual(f.calls, []); assert.deepEqual(f.waits, [])
  }
})
