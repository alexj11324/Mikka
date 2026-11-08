import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import * as net from 'node:net'

const repo = process.argv[2]
const output = process.argv[3]
assert.ok(repo && output)
assert.equal(process.version, 'v24.22.1')
assert.equal(Boolean(process.env.VERCEL), false, 'local-only benchmark excludes Vercel lifecycle')
const revision = '6180cd8889006f4e1618c2549b1aa12d13506ee8'
const sourcePath = join(repo, 'lib/db/pool-lifecycle.ts')
const sourceBytes = await readFile(sourcePath)
const sourceSha = createHash('sha256').update(sourceBytes).digest('hex')
assert.equal(sourceSha, '25bfe3d3803e2e299d3572ff34b932e430806efecded767cda2b201291e0bdf6')
const scriptBytes = await readFile(new URL(import.meta.url))
const scriptSha = createHash('sha256').update(scriptBytes).digest('hex')
const started = new Date().toISOString()
const require = createRequire(join(repo, 'package.json'))
const { Pool } = require('pg')
const pgVersion = require('pg/package.json').version
const { manageDatabasePool } = await import(pathToFileURL(sourcePath).href)
let networkAttempts = 0
let sqlCalls = 0
let clientsConstructed = 0
const originalConnect = net.Socket.prototype.connect
const originalFetch = globalThis.fetch
net.Socket.prototype.connect = function () {
  networkAttempts++
  throw new Error('BENCHMARK_NETWORK_FORBIDDEN')
}
globalThis.fetch = () => {
  networkAttempts++
  throw new Error('BENCHMARK_NETWORK_FORBIDDEN')
}
class ControlledClient extends EventEmitter {
  _queryable = true
  _ending = false
  constructor() { super(); clientsConstructed++ }
  connect(callback) { queueMicrotask(callback) }
  end(callback) { callback?.() }
  query() { sqlCalls++; throw new Error('BENCHMARK_SQL_FORBIDDEN') }
}
const request = new AsyncLocalStorage()
const operation = new AsyncLocalStorage()
const trace = new AsyncLocalStorage()
const within = (value, fn) => request.run(value, () => operation.run(value + '-operation', () => trace.run(value + '-trace', fn)))
const caller = 'synthetic-caller'
const foreign = 'synthetic-releaser'
const make = async managed => {
  const pool = new Pool({ max: 1, idleTimeoutMillis: 0, Client: ControlledClient })
  if (managed) manageDatabasePool(pool)
  else pool.on('error', () => {})
  const first = await pool.connect()
  let releaseHeld = first.release
  let nextRelease
  let received
  let calls = 0
  let bad = 0
  const expected = managed ? caller : foreign
  const callback = (error, client, release) => {
    if (error) throw error
    nextRelease = release
    received = [request.getStore(), operation.getStore(), trace.getStore()]
    calls++
  }
  const validate = () => {
    if (!nextRelease || received[0] !== expected || received[1] !== expected + '-operation' || received[2] !== expected + '-trace') bad++
    releaseHeld = nextRelease
    nextRelease = undefined
  }
  const timeOne = () => {
    let enqueued
    within(caller, () => {
      const begin = process.hrtime.bigint()
      pool.connect(callback)
      enqueued = Number(process.hrtime.bigint() - begin)
    })
    assert.equal(pool.waitingCount, 1, 'every measured callback must queue behind a held connection')
    let drained
    within(foreign, () => {
      const begin = process.hrtime.bigint()
      releaseHeld()
      drained = Number(process.hrtime.bigint() - begin)
    })
    validate()
    assert.equal(pool.waitingCount, 0)
    return { enqueue_ns: enqueued, drain_ns: drained, active_ns: enqueued + drained }
  }
  const untimedOne = () => {
    within(caller, () => pool.connect(callback))
    if (pool.waitingCount !== 1) throw new Error('QUEUE_NOT_EXERCISED')
    within(foreign, releaseHeld)
    validate()
    if (pool.waitingCount !== 0) throw new Error('QUEUE_NOT_DRAINED')
  }
  return {
    pool, timeOne, untimedOne,
    evidence: () => ({ callbacks: calls, context_mismatches: bad, waiting: pool.waitingCount, total_clients: pool.totalCount, idle: pool.idleCount }),
    close: async () => { releaseHeld(); await pool.end() },
  }
}
const quantile = (sorted, q) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]
const describe = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return { n: values.length, mean: values.reduce((a,b) => a+b, 0) / values.length, p50: quantile(sorted, .5), p95: quantile(sorted, .95), p99: quantile(sorted, .99), min: sorted[0], max: sorted.at(-1) }
}
const samples = []
const batches = []
let base
let wrapped
let result
try {
  base = await make(false)
  wrapped = await make(true)
  const warmupPairs = 1000
  for (let index = 0; index < warmupPairs; index++) {
    if (index % 2) { wrapped.untimedOne(); base.untimedOne() }
    else { base.untimedOne(); wrapped.untimedOne() }
  }
  const pairs = 2000
  for (let index = 0; index < pairs; index++) {
    let control, candidate
    if (index % 2) { candidate = wrapped.timeOne(); control = base.timeOne() }
    else { control = base.timeOne(); candidate = wrapped.timeOne() }
    samples.push({ index, order: index % 2 ? 'wrapped_then_base' : 'base_then_wrapped', base: control, wrapped: candidate, delta_active_ns: candidate.active_ns - control.active_ns })
  }
  const operationsPerBatch = 128
  const batchPairs = 512
  const runBatch = state => {
    const beforeCpu = process.cpuUsage()
    const beforeWall = process.hrtime.bigint()
    for (let op = 0; op < operationsPerBatch; op++) state.untimedOne()
    const wallNs = Number(process.hrtime.bigint() - beforeWall)
    const cpu = process.cpuUsage(beforeCpu)
    return { operations: operationsPerBatch, wall_ns: wallNs, user_cpu_us: cpu.user, system_cpu_us: cpu.system, total_cpu_us: cpu.user + cpu.system }
  }
  for (let index = 0; index < batchPairs; index++) {
    let control, candidate
    if (index % 2) { candidate = runBatch(wrapped); control = runBatch(base) }
    else { control = runBatch(base); candidate = runBatch(wrapped) }
    batches.push({ index, order: index % 2 ? 'wrapped_then_base' : 'base_then_wrapped', base: control, wrapped: candidate,
      delta_wall_ns: candidate.wall_ns - control.wall_ns, delta_cpu_us: candidate.total_cpu_us - control.total_cpu_us })
  }
  const controlEvidence = base.evidence(), candidateEvidence = wrapped.evidence()
  const expectedCallbacks = warmupPairs + pairs + operationsPerBatch * batchPairs
  assert.equal(controlEvidence.callbacks, expectedCallbacks)
  assert.equal(candidateEvidence.callbacks, expectedCallbacks)
  assert.equal(controlEvidence.context_mismatches, 0)
  assert.equal(candidateEvidence.context_mismatches, 0)
  assert.equal(networkAttempts, 0)
  assert.equal(sqlCalls, 0)
  assert.equal(clientsConstructed, 2)
  result = {
    schema: 1, kind: 'actual_manageDatabasePool_callback_queue_cpu_microbenchmark',
    started_at: started, completed_at: new Date().toISOString(),
    source: { revision, path: 'lib/db/pool-lifecycle.ts', git_blob: '5732f6a883aa55c38bd220508439670561b0b2be', sha256: sourceSha, bytes: sourceBytes.length, benchmark_sha256: scriptSha },
    runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, pg_version: pgVersion, vercel: false },
    design: {
      pairing: 'AB/BA alternating order for warmup, single operations and batches; same inputs and one real pg.Pool per variant',
      wrapper: 'candidate imports and invokes the actual current manageDatabasePool; control uses the same real pg.Pool without that wrapper and with the same inert error listener',
      queue: 'max=1; controlled in-memory client remains checked out; every callback queues once and the previous holder releases under a foreign context; the new callback retains the lease for the next sample',
      contexts: 'three synthetic AsyncLocalStorage instances are active; candidate callbacks retain caller stores, control callbacks see foreign releaser stores',
      transport: 'ControlledClient connects only via queueMicrotask; query throws; net.Socket.connect and fetch throw; idleTimeoutMillis=0 excludes unrelated idle timer scheduling',
      single_operation_measurement: 'sum of two separately timed synchronous intervals: callback registration/enqueue and previous-lease release/queue drain. process.hrtime.bigint reports elapsed wall time, not per-operation process CPU time. Context setup and assertions outside those intervals are excluded.',
      batch_measurement: '128 operations per batch, 512 matched batch pairs. process.cpuUsage measures aggregate user+system CPU; hrtime measures batch wall time. These batch windows include the same synthetic context entry, validation and driver work for both variants. Values divided by 128 are batch means, never individual-operation quantiles.',
      excluded: ['PostgreSQL connection handshake', 'real PostgreSQL network', 'SQL execution', 'HTTP', 'model calls', 'PostHog export', 'real OTel SDK recording', 'production concurrency distribution', 'Vercel suspension lifecycle'],
      no_performance_threshold: true, warmup_pairs: warmupPairs, measured_single_pairs: pairs, measured_batch_pairs: batchPairs, operations_per_batch: operationsPerBatch,
      retained_negative_deltas: true, note: 'OS scheduling/GC can affect elapsed samples; batch CPU also includes other process work such as GC. No production request latency claim.'
    },
    summaries: {
      single_operation_active_elapsed_ns: {
        base: describe(samples.map(x => x.base.active_ns)),
        wrapped: describe(samples.map(x => x.wrapped.active_ns)),
        paired_delta: describe(samples.map(x => x.delta_active_ns))
      },
      batch_cpu_mean_us_per_operation: {
        base: describe(batches.map(x => x.base.total_cpu_us / operationsPerBatch)),
        wrapped: describe(batches.map(x => x.wrapped.total_cpu_us / operationsPerBatch)),
        paired_delta: describe(batches.map(x => x.delta_cpu_us / operationsPerBatch))
      },
      batch_elapsed_mean_ns_per_operation: {
        base: describe(batches.map(x => x.base.wall_ns / operationsPerBatch)),
        wrapped: describe(batches.map(x => x.wrapped.wall_ns / operationsPerBatch)),
        paired_delta: describe(batches.map(x => x.delta_wall_ns / operationsPerBatch))
      }
    },
    correctness: { base: controlEvidence, wrapped: candidateEvidence, expected_callbacks_per_variant: expectedCallbacks, network_attempts: networkAttempts, sql_calls: sqlCalls, controlled_clients_constructed: clientsConstructed },
    raw_single_pairs: samples, raw_batch_pairs: batches,
  }
} finally {
  if (base) await base.close()
  if (wrapped) await wrapped.close()
  net.Socket.prototype.connect = originalConnect
  globalThis.fetch = originalFetch
}
result.cleanup = { base_pool_ended: base.pool.ended, wrapped_pool_ended: wrapped.pool.ended, network_guard_restored: net.Socket.prototype.connect === originalConnect, external_resources_created: 0 }
assert.equal(result.cleanup.base_pool_ended, true)
assert.equal(result.cleanup.wrapped_pool_ended, true)
await writeFile(output, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ source: result.source, runtime: result.runtime, summaries: result.summaries, correctness: result.correctness, cleanup: result.cleanup }))

