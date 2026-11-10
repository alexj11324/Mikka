import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build, createDevServer, createNitro, prepare } from 'nitro/builder'
import { nodeRuntimePackages } from '../build-contract.mjs'
import { compileTracing } from '../scripts/finalize-build.mjs'
import { developmentTracing, developmentWorkerReady } from '../scripts/dev.mjs'
import { decodeOtlp } from '../../../tests/mvp/trace-collector.mjs'

const repository = fileURLToPath(new URL('../../../', import.meta.url))

// The actual Nitro/Rolldown worker must instrument the external pg instance.
// A public pg query after client.end exercises its error path without opening
// a database connection; the full trace chain independently tests real SQL.
test('real development workers instrument pg before application imports, including hot replacements', { timeout: 60_000 }, async () => {
  const spans = [], sentinel = 'private-dev-pg-parameter'
  let privateBytes = false
  const collector = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    privateBytes ||= body.includes(sentinel)
    if (request.url.endsWith('/traces')) spans.push(...decodeOtlp(body, 'traces'))
    response.writeHead(200, { 'content-type': 'application/x-protobuf' }); response.end()
  })
  await new Promise((resolve, reject) => { collector.once('error', reject); collector.listen(0, '127.0.0.1', resolve) })
  const endpoint = `http://127.0.0.1:${collector.address().port}/i/v1/traces`
  const values = { NODE_ENV: 'development', CI: '', NEXT_PUBLIC_POSTHOG_KEY: 'phc_development_runtime_fixture',
    MIKKA_TRACE_SAMPLE_RATE: '1', MIKKA_TRACE_ENDPOINT: endpoint }
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  Object.assign(process.env, values)
  await mkdir(join(repository, '.cache'), { recursive: true })
  const directory = await mkdtemp(join(repository, '.cache/dev-tracing-'))
  const route = join(directory, 'route.mjs')
  const routeSource = version => `import pg from 'pg';
import { trace } from '@opentelemetry/api';
import { defineHandler } from 'nitro';
import { threadId } from 'node:worker_threads';
export default defineHandler(async () => {
  const provider = globalThis[Symbol.for('mikka.tracing')];
  let parentId, queryFailed = false;
  await trace.getTracer('development-contract').startActiveSpan('test.request', async span => {
    parentId = span.spanContext().spanId;
    const client = new pg.Client();
    await client.end();
    try { await client.query('SELECT $1::text', [${JSON.stringify(sentinel)}]); }
    catch { queryFailed = true; }
    finally { span.end(); }
  });
  await provider?.forceFlush();
  return { providerStarted: Boolean(provider), pgWrapped: pg.Client.prototype.query.__wrapped === true, parentId, queryFailed, version: ${version}, workerId: threadId };
});\n`
  await writeFile(route, routeSource(1), { mode: 0o600 })
  let nitro, worker
  try {
    nitro = await createNitro({ rootDir: directory, workspaceDir: repository, dev: true, preset: 'nitro-dev', builder: 'rolldown', logLevel: 0,
      buildDir: join(directory, 'build'), output: { dir: join(directory, 'output') }, routes: { '/**': route },
      serveStatic: false, publicAssets: [], imports: false, rolldownConfig: { external: nodeRuntimePackages } }, { dotenv: false })
    developmentTracing(nitro, await compileTracing(repository))
    const api = createDevServer(nitro)
    worker = developmentWorkerReady(api)
    const compiled = Promise.withResolvers(); void compiled.promise.catch(() => {})
    nitro.hooks.hookOnce('dev:reload', () => compiled.resolve())
    nitro.hooks.hookOnce('dev:error', error => compiled.reject(error))
    const listener = api.listen({ port: 0, hostname: '127.0.0.1' }); await listener.ready()
    await prepare(nitro); await build(nitro); await compiled.promise; await worker.wait(AbortSignal.timeout(30_000))
    let previousWorker
    for (const version of [1, 2]) {
      if (version === 2) {
        worker = developmentWorkerReady(api, { phase: 'hot-replacement' })
        await writeFile(route, routeSource(version), { mode: 0o600 })
        await worker.wait(AbortSignal.timeout(30_000))
      }
      const response = await fetch(listener.url, { signal: AbortSignal.timeout(10_000) })
      assert.equal(response.status, 200)
      const result = await response.json()
      assert.equal(result.providerStarted, true)
      assert.equal(result.pgWrapped, true)
      assert.equal(result.queryFailed, true)
      assert.equal(result.version, version)
      assert.notEqual(result.workerId, previousWorker)
      previousWorker = result.workerId
      const query = spans.find(span => span.attributes['db.system.name'] === 'postgresql' && span.parentSpanId === result.parentId)
      assert.ok(query, 'DEVELOPMENT_PG_SPAN_MISSING')
      assert.equal(query.status, 2)
      assert.equal(privateBytes, false)
    }
  } finally {
    worker?.dispose()
    try { await nitro?.close() }
    finally {
      collector.closeAllConnections(); await new Promise(resolve => collector.close(resolve))
      for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value
      // Nitro's Rolldown close hook starts watcher shutdown without awaiting it.
      // Retry only transient removal conflicts in this test's owned directory.
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }
})
