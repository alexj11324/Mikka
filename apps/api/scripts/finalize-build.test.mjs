import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileTracing, finalizeBuild, wrapFunction } from './finalize-build.mjs'

const exec = promisify(execFile)

test('actual packaged bootstrap patches pg before application import and preserves Vercel function contract', async () => {
  const cache = join(process.cwd(), 'node_modules/.cache')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'mikka-function-'))
  const config = {
    handler: 'index.mjs', runtime: 'nodejs24.x', launcherType: 'Nodejs',
    supportsResponseStreaming: true, supportsCancellation: true, maxDuration: 120,
    experimentalTriggers: [{ type: 'queue/v2beta', topic: '__wkf_workflow_*', consumer: 'workflow', retryAfterSeconds: 5 }],
  }
  try {
    await writeFile(join(directory, '.vc-config.json'), JSON.stringify(config))
    // Load the actual installed pg after the actual compiled production
    // tracing bootstrap. A metadata/string-order assertion would miss this.
    await writeFile(join(directory, 'index.mjs'), 'import pg from "pg"\nexport default { pgWrapped: pg.Client.prototype.query.__wrapped === true }\n')
    await wrapFunction(directory, await compileTracing(process.cwd()))
    assert.deepEqual(JSON.parse(await readFile(join(directory, '.vc-config.json'), 'utf8')), { ...config, handler: 'mikka-entry.mjs' })
    const { stdout, stderr } = await exec(process.execPath, ['--input-type=module', '-e', `
      const { default: app } = await import(${JSON.stringify(new URL(`file://${join(directory, 'mikka-entry.mjs')}`).href)})
      const provider = globalThis[Symbol.for('mikka.tracing')]
      console.log(JSON.stringify({ pgWrapped: app.pgWrapped, providerStarted: Boolean(provider) }))
      await provider?.shutdown()
    `], {
      cwd: process.cwd(), timeout: 10_000,
      env: { PATH: process.env.PATH, NODE_ENV: 'development', CI: '',
        NEXT_PUBLIC_POSTHOG_KEY: 'phc_bootstrap_test_only', MIKKA_TRACE_SAMPLE_RATE: '1', MIKKA_TRACE_ENDPOINT: 'http://127.0.0.1:1/i/v1/traces' },
    })
    assert.deepEqual(JSON.parse(stdout), { pgWrapped: true, providerStarted: true })
    assert.equal(stderr, '')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('unexpected generated Vercel handler fails instead of silently changing runtime semantics', async () => {
  const cache = join(process.cwd(), 'node_modules/.cache')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'mikka-function-'))
  try {
    await writeFile(join(directory, '.vc-config.json'), JSON.stringify({ runtime: 'edge', handler: 'index.js' }))
    await assert.rejects(wrapFunction(directory, Buffer.from('')), /API_FUNCTION_RUNTIME_MISMATCH/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('Node and Vercel bundles preserve the real executable ffmpeg and its licensing files', { timeout: 60_000 }, async t => {
  const root = process.cwd(), cache = join(root, 'node_modules/.cache')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'mikka-runtime-resources-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const paths = ['node_modules/ffmpeg-static/ffmpeg', 'node_modules/ffmpeg-static/ffmpeg.README',
    'node_modules/ffmpeg-static/ffmpeg.LICENSE', 'node_modules/ffmpeg-static/LICENSE', 'node_modules/ffmpeg-static/README.md']
  const expected = await Promise.all(paths.map(async path => {
    const bytes = await readFile(join(root, path))
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }))
  for (const preset of ['node-server', 'vercel']) await t.test(preset, async () => {
    const output = join(directory, preset)
    const packaged = preset === 'vercel' ? join(output, 'functions/__server.func') : output
    const server = preset === 'vercel' ? packaged : join(output, 'server')
    await mkdir(server, { recursive: true })
    await writeFile(join(server, 'index.mjs'), 'export default null\n')
    if (preset === 'vercel') {
      await writeFile(join(output, 'config.json'), JSON.stringify({ version: 3, routes: [] }))
      await writeFile(join(server, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs24.x', handler: 'index.mjs' }))
    } else await writeFile(join(server, 'docker-entry.mjs'), 'export const createDockerRuntime = () => {}\n')

    // Exercise the final production copy with the installed binary, not a
    // fake executable or a source-path assertion. A lost mode bit must fail.
    const evidence = await finalizeBuild({ root, output, preset,
      revision: process.env.MIKKA_TEST_DEPLOYMENT_SHA || 'a'.repeat(40) })
    for (const resource of expected) {
      assert.deepEqual(evidence.resources.find(item => item.path === resource.path), resource)
      const copied = await readFile(join(packaged, resource.path))
      assert.equal(copied.length, resource.bytes)
      assert.equal(createHash('sha256').update(copied).digest('hex'), resource.sha256)
    }
    const { stdout, stderr } = await exec(join(packaged, paths[0]), ['-version'],
      { cwd: packaged, timeout: 15_000, maxBuffer: 64 * 1024 })
    assert.match(stdout, /^ffmpeg version /)
    assert.equal(stderr, '')
  })
})
