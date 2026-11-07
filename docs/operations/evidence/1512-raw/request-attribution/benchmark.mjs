import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// CPU-only comparison: exact pre-change source versus current source, ordinary
// request logging, one pre-auth span and four post-auth spans. Both providers
// sanitize into counters; no server, database, real exporter or provider call.
const repo = resolve(process.argv[2] ?? '.')
const baselineCommit = 'a6a584ae9070ae40454bc5d94bcf5068bdb66209'
const require = createRequire(join(repo, 'package.json'))
const { context, propagation, ROOT_CONTEXT, trace } = require('@opentelemetry/api')
const { AlwaysOnSampler, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base')
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')
const { SafeExporter } = await import(pathToFileURL(join(repo, 'lib/tracing/node.ts')))
const temporary = mkdtempSync(join(tmpdir(), 'mikka-request-attribution-bench-'))
const files = ['lib/request-log.ts', 'lib/tracing/spans.ts', 'lib/desktop-rpc/handler.ts']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceHashes = Object.fromEntries(files.map(file => [file, hash(readFileSync(join(repo, file)))]))

function baselineModule(file) {
  const original = execFileSync('git', ['show', `${baselineCommit}:${file}`], { cwd: repo, encoding: 'utf8' })
  const rewritten = original.replace(/(from\s+)(['"])([^'"]+)\2/g, (match, from, quote, specifier) => {
    if (specifier.startsWith('node:')) return match
    let target = specifier.startsWith('.') ? resolve(repo, dirname(file), specifier)
      : specifier.startsWith('@/') ? resolve(repo, specifier.slice(2)) : require.resolve(specifier)
    if (!existsSync(target) && existsSync(`${target}.ts`)) target += '.ts'
    return `${from}${quote}${pathToFileURL(target).href}${quote}`
  })
  const target = join(temporary, file.replaceAll('/', '-') + '.mts')
  writeFileSync(target, rewritten)
  return import(pathToFileURL(target))
}

const baseline = { log: await baselineModule('lib/request-log.ts'), spans: await baselineModule('lib/tracing/spans.ts') }
const current = { log: await import(pathToFileURL(join(repo, 'lib/request-log.ts'))), spans: await import(pathToFileURL(join(repo, 'lib/tracing/spans.ts'))) }
const providers = []
function runner(modules) {
  let exported = 0
  const exporter = { export(spans, done) { exported += spans.length; done({ code: 0 }) }, shutdown: async () => {}, forceFlush: async () => {} }
  const provider = new NodeTracerProvider({ sampler: new AlwaysOnSampler(), spanProcessors: [
    new modules.spans.RouteAttributesProcessor(), new SimpleSpanProcessor(new SafeExporter(exporter)),
  ] })
  providers.push(provider)
  const tracer = provider.getTracer('request-attribution-benchmark')
  const handler = modules.log.withRequestLog('/api/desktop/rpc', () => {
    tracer.startSpan('before-auth-query').end()
    modules.log.noteLogUser('benchmark-user')
    modules.log.noteLogUser('benchmark-user')
    modules.log.noteLogRpcAction?.('model-order.getModelOrder')
    for (let index = 0; index < 4; index++) tracer.startSpan('action-query').end()
    return new Response(null, { status: 204 })
  }, () => {})
  return { provider, count: () => exported, run: async () => {
    const request = new Request('https://fixture.invalid/api/desktop/rpc', { method: 'POST' })
    const started = performance.now()
    await context.with(ROOT_CONTEXT, () => tracer.startActiveSpan('request', async span => {
      try { assert.equal((await handler(request)).status, 204) } finally { span.end() }
    }))
    return (performance.now() - started) * 1_000
  } }
}
const previous = runner(baseline), next = runner(current)
next.provider.register()
const warmup = 120, samples = 500
const timings = { baseline: [], current: [] }
try {
  for (let index = 0; index < warmup; index++) { await previous.run(); await next.run() }
  for (let index = 0; index < samples; index++) {
    if (index % 2) { timings.current.push(await next.run()); timings.baseline.push(await previous.run()) }
    else { timings.baseline.push(await previous.run()); timings.current.push(await next.run()) }
  }
  await Promise.all(providers.map(provider => provider.forceFlush()))
  assert.equal(previous.count(), (warmup + samples) * 6)
  assert.equal(next.count(), previous.count())
  for (const file of files) assert.equal(hash(readFileSync(join(repo, file))), sourceHashes[file], 'Source changed during benchmark')
  const percentiles = values => {
    const ordered = [...values].sort((a, b) => a - b)
    return Object.fromEntries([['p50', 0.5], ['p95', 0.95], ['p99', 0.99]].map(([name, fraction]) => [name, Number(ordered[Math.ceil(ordered.length * fraction) - 1].toFixed(3))]))
  }
  const result = { schemaVersion: 1, scope: 'offline CPU only; request logs and six spans with immediate safe export into counters',
    baselineCommit, sourceHashes, nodeVersion: process.version, samples, warmup, unit: 'microseconds',
    baseline: percentiles(timings.baseline), current: percentiles(timings.current),
    pairedDifference: percentiles(timings.current.map((value, index) => value - timings.baseline[index])),
    exportedSpansPerVariant: next.count(), externalRequests: 0,
  }
  writeFileSync(new URL('./request-attribution-bench.json', import.meta.url), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally {
  await Promise.all(providers.map(provider => provider.shutdown()))
  trace.disable(); context.disable(); propagation.disable()
  rmSync(temporary, { recursive: true, force: true })
}
