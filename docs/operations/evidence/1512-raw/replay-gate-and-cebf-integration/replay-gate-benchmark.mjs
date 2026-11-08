import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
const { repo } = JSON.parse(fs.readFileSync('/vercel/sandbox/replay-gate-paths.json', 'utf8'))
const { installReplayReadiness } = await import(pathToFileURL(path.join(repo, 'lib/replay-readiness.ts')).href)
const A = '77777777-7777-4777-8777-777777777777', B = '88888888-8888-4888-8888-888888888888'
const target = {}, observer = installReplayReadiness(target)
observer.bind({ onSessionId(callback) { callback(A); return () => {} }, sessionRecordingStarted() { return true } })
const ordinary = { event: '$pageview', properties: { $session_id: A } }
const snapshots = [A, B].map(id => ({ event: '$snapshot', properties: { $session_id: id } }))
const samples = 1000, perSample = 128, warmup = 5000
const quantile = (values, q) => values[Math.ceil(q * values.length) - 1]
const measurements = []
for (const [name, event] of [
  ['ordinary_event_fast_return', () => ordinary],
  ['snapshot_same_session', () => snapshots[0]],
  ['snapshot_session_changes', i => snapshots[i % 2]],
]) {
  for (let i = 0; i < warmup; i++) observer.observe(event(i))
  const values = []
  for (let n = 0; n < samples; n++) {
    const start = process.hrtime.bigint()
    for (let i = 0; i < perSample; i++) observer.observe(event(i))
    values.push(Number(process.hrtime.bigint() - start) / perSample / 1e6)
  }
  values.sort((a, b) => a - b)
  measurements.push({ name, samples, observations_per_sample: perSample,
    p50_ms: quantile(values, 0.5), p95_ms: quantile(values, 0.95), p99_ms: quantile(values, 0.99),
    max_ms: values.at(-1) })
}
const source = fs.readFileSync(path.join(repo, 'lib/replay-readiness.ts'))
const receipt = { kind: 'readonly_replay_observer_microbenchmark', source_revision: 'fa2830e0576233d8de54f72eec56ec74b4ca95d1_plus_frozen_patch',
  source_sha256: createHash('sha256').update(source).digest('hex'), node: process.version, platform: process.platform,
  vcpus: 1, memory_mb: 2048, network: 'deny-all', fixture: 'closed synthetic metadata only; no snapshot body',
  warmup_per_path: warmup, measurements, measured_at_utc: new Date().toISOString(),
  scope: 'Only added observer function calls; batch timer amortization, no network, SDK transport, real browser, model, end-to-end or production latency claim.' }
fs.writeFileSync('/vercel/sandbox/replay-gate-benchmark.json', JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify(receipt))
