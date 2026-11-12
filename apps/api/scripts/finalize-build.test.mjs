import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileTracing, finalizeBuild, wrapFunction } from './finalize-build.mjs'
import { createCapturePosterBinary, POSTER_BINARY_ARCHIVE, POSTER_BINARY_MANIFEST, POSTER_BINARY_MAX_BYTES,
  POSTER_BINARY_RESOURCE, POSTER_LICENSE_FILES, POSTER_RUNTIME_DIRECTORY } from '../../../lib/captures/poster-binary.mjs'

const exec = promisify(execFile)

test('final packaging retains every route but does not duplicate equivalent API implementations and resources', { timeout: 120_000 }, async t => {
  const root = process.cwd(), cache = join(root, '.output')
  await mkdir(cache, { recursive: true })
  const output = await mkdtemp(join(cache, 'function-dedupe-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  await writeFile(join(output, 'config.json'), JSON.stringify({ version: 3, routes: [
    { src: '/mikka/api/a', dest: '/a' }, { src: '/mikka/api/b', dest: '/b' },
  ] }))
  const configuration = { runtime: 'nodejs24.x', handler: 'index.mjs', maxDuration: 120, supportsCancellation: true }
  for (const name of ['a', 'b']) {
    const directory = join(output, 'functions', name + '.func')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'index.mjs'), 'export default null\n')
    await writeFile(join(directory, '.vc-config.json'), JSON.stringify(configuration))
  }
  const result = await finalizeBuild({ root, output, preset: 'vercel', revision: process.env.MIKKA_TEST_DEPLOYMENT_SHA || 'a'.repeat(40) })
  assert.equal(result.functions.length, 1)
  assert.ok((await lstat(join(output, 'functions/b.func'))).isSymbolicLink())
  assert.equal((JSON.parse(await readFile(join(output, 'config.json')))).routes.length, 2)
  for (const name of ['a', 'b']) {
    const directory = join(output, 'functions', name + '.func')
    assert.deepEqual(JSON.parse(await readFile(join(directory, '.vc-config.json'))), { ...configuration, handler: 'mikka-entry.mjs' })
    for (const resource of result.resources) assert.equal(createHash('sha256').update(await readFile(join(directory, resource.path))).digest('hex'), resource.sha256)
  }
})

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

test('Node and Vercel bundles extract the verified real ffmpeg once and preserve its licensing files', { timeout: 120_000 }, async t => {
  const root = process.cwd(), cache = join(root, 'node_modules/.cache')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'mikka-runtime-resources-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const original = await readFile(join(root, POSTER_BINARY_RESOURCE))
  const expected = await Promise.all(POSTER_LICENSE_FILES.map(async name => {
    const bytes = await readFile(join(root, dirname(POSTER_BINARY_RESOURCE), name))
    return { path: `${POSTER_RUNTIME_DIRECTORY}/${name}`, bytes: bytes.length, sha256: hash(bytes) }
  }))
  assert.equal(await createCapturePosterBinary({ root })(), join(root, POSTER_BINARY_RESOURCE), 'development keeps the pinned native executable')
  for (const preset of ['node-server', 'vercel']) await t.test(preset, async () => {
    const output = join(directory, preset)
    const packaged = preset === 'vercel' ? join(output, 'functions/__server.func') : output
    const server = preset === 'vercel' ? packaged : join(output, 'server')
    await mkdir(server, { recursive: true })
    await writeFile(join(server, 'index.mjs'), 'export default null\n')
    if (preset === 'vercel') {
      await writeFile(join(output, 'config.json'), JSON.stringify({ version: 3, routes: [] }))
      await writeFile(join(server, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs24.x', handler: 'index.mjs' }))
      // A traced package link must be removed without touching its source.
      await mkdir(join(packaged, 'node_modules'), { recursive: true })
      await symlink(join(root, dirname(POSTER_BINARY_RESOURCE)), join(packaged, dirname(POSTER_BINARY_RESOURCE)), 'dir')
    } else await writeFile(join(server, 'docker-entry.mjs'), 'export const createDockerRuntime = () => {}\n')

    // Exercise the final production bytes and the production resolver, not a
    // fake executable or a source-path assertion. A lost mode bit must fail.
    const evidence = await finalizeBuild({ root, output, preset,
      revision: process.env.MIKKA_TEST_DEPLOYMENT_SHA || 'a'.repeat(40) })
    for (const resource of expected) {
      assert.deepEqual(evidence.resources.find(item => item.path === resource.path), resource)
      const copied = await readFile(join(packaged, resource.path))
      assert.equal(copied.length, resource.bytes)
      assert.equal(hash(copied), resource.sha256)
    }
    const archive = await readFile(join(packaged, POSTER_BINARY_ARCHIVE))
    const manifest = JSON.parse(await readFile(join(packaged, POSTER_BINARY_MANIFEST), 'utf8'))
    assert.deepEqual(manifest, evidence.posterBinary)
    assert.equal(manifest.bytes, original.length); assert.equal(manifest.sha256, hash(original))
    assert.equal(manifest.gzipBytes, archive.length); assert.equal(manifest.gzipSha256, hash(archive))
    assert.ok(archive.length < original.length)
    for (const path of [POSTER_BINARY_ARCHIVE, POSTER_BINARY_MANIFEST]) {
      const bytes = await readFile(join(packaged, path))
      assert.deepEqual(evidence.resources.find(resource => resource.path === path), { path, bytes: bytes.length, sha256: hash(bytes) })
    }
    assert.ok(!evidence.resources.some(resource => resource.path.startsWith('node_modules/')))
    await assert.rejects(lstat(join(packaged, POSTER_BINARY_RESOURCE)), error => error.code === 'ENOENT')
    if (preset === 'node-server') await assert.rejects(lstat(join(packaged, 'node_modules')), error => error.code === 'ENOENT')
    assert.equal(hash(await readFile(join(root, POSTER_BINARY_RESOURCE))), hash(original))
    const temporaryRoot = join(directory, `${preset}-temporary`)
    await mkdir(temporaryRoot)
    const binary = createCapturePosterBinary({ root: packaged, temporaryRoot })
    const first = binary(), concurrent = Array.from({ length: 8 }, () => binary())
    for (const promise of concurrent) assert.equal(promise, first, 'concurrent requests share one pending extraction')
    const resolved = await Promise.all([first, ...concurrent])
    assert.equal(new Set(resolved).size, 1); assert.equal((await readdir(temporaryRoot)).length, 1)
    assert.equal(hash(await readFile(resolved[0])), hash(original))
    assert.equal((await lstat(dirname(resolved[0]))).mode & 0o777, 0o700)
    assert.equal((await lstat(resolved[0])).mode & 0o777, 0o500)
    const { stdout, stderr } = await exec(resolved[0], ['-version'],
      { cwd: packaged, timeout: 15_000, maxBuffer: 64 * 1024 })
    assert.match(stdout, /^ffmpeg version /)
    assert.equal(stderr, '')
    t.diagnostic(JSON.stringify({ preset, ffmpegBytes: original.length, packagedBytes: archive.length }))

    if (preset === 'vercel') {
      const failedRoot = join(directory, 'failed-extraction')
      await mkdir(failedRoot)
      const retry = createCapturePosterBinary({ root: packaged, temporaryRoot: failedRoot })
      const manifestPath = join(packaged, POSTER_BINARY_MANIFEST)
      try {
        await writeFile(manifestPath, JSON.stringify({ ...manifest, sha256: '0'.repeat(64) }))
        const failed = retry()
        assert.equal(retry(), failed)
        await assert.rejects(failed, /capturePosterBinaryChecksumMismatch/)
        assert.deepEqual(await readdir(failedRoot), [], 'failed bytes are removed before another request retries')
        await writeFile(manifestPath, JSON.stringify({ ...manifest, bytes: manifest.bytes - 1 }))
        await assert.rejects(retry(), /capturePosterBinarySizeExceeded/)
        assert.deepEqual(await readdir(failedRoot), [], 'decompression stops at its declared size')
        await writeFile(manifestPath, JSON.stringify({ ...manifest, bytes: POSTER_BINARY_MAX_BYTES + 1 }))
        await assert.rejects(retry(), /capturePosterBinaryManifestInvalid/)
        assert.deepEqual(await readdir(failedRoot), [])
        await writeFile(manifestPath, JSON.stringify(manifest))
        const recovered = await Promise.all([retry(), retry()])
        assert.equal(recovered[0], recovered[1]); assert.equal((await readdir(failedRoot)).length, 1)
        assert.equal(hash(await readFile(recovered[0])), hash(original))
        assert.match((await exec(recovered[0], ['-version'], { timeout: 15_000, maxBuffer: 64 * 1024 })).stdout, /^ffmpeg version /)
      } finally { await writeFile(manifestPath, JSON.stringify(manifest)) }
    }
  })
})
