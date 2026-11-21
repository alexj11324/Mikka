import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { finalizeBuild } from './finalize-build.mjs'
import { createCapturePosterBinary, POSTER_BINARY_ARCHIVE, POSTER_BINARY_MANIFEST,
  POSTER_BINARY_RESOURCE, POSTER_LICENSE_FILES, POSTER_RUNTIME_DIRECTORY } from '../../../lib/captures/poster-binary.mjs'

const exec = promisify(execFile)

test('Node bundles extract the verified real ffmpeg once and preserve its licensing files', { timeout: 120_000 }, async t => {
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
  await t.test('node-server', async () => {
    const preset = 'node-server'
    const output = join(directory, preset)
    const packaged = output
    const server = join(output, 'server')
    await mkdir(server, { recursive: true })
    await writeFile(join(server, 'index.mjs'), 'export default null\n')
    await writeFile(join(server, 'docker-entry.mjs'), 'export const createDockerRuntime = () => {}\n')

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

  })
})
