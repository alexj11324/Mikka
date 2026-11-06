import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { readCompiledBuild, readCompiledDockerBuild, serverOptions } from './start-app.mjs'

test('compiled production identity is checked before server code can execute', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-start-contract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.output/server'), { recursive: true })
  await writeFile(join(root, '.output/server/mikka-entry.mjs'), 'throw new Error("SERVER_MUST_NOT_IMPORT")\n')
  const revision = 'a'.repeat(40)
  const manifest = { version: 1, revision, testDeploymentSha: revision,
    preset: 'node-server', node: process.version, basePath: '/mikka', appBuild: revision,
    lockSha256: 'b'.repeat(64), routesSha256: 'c'.repeat(64), tracingSha256: 'd'.repeat(64) }
  const save = value => writeFile(join(root, '.output/mikka-build.json'), JSON.stringify(value))
  await save(manifest)
  assert.equal((await readCompiledBuild(root, { env: { MIKKA_TEST_DEPLOYMENT_SHA: revision } })).revision, revision)
  await assert.rejects(readCompiledBuild(root, { env: { MIKKA_TEST_DEPLOYMENT_SHA: 'e'.repeat(40) } }), /APP_COMPILED_REVISION_MISMATCH/)
  await save({ ...manifest, testDeploymentSha: '' })
  await assert.rejects(readCompiledBuild(root, { expectedRevision: revision }), /APP_COMPILED_REVISION_MISMATCH/)
  await save({ ...manifest, preset: 'vercel' })
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./start-app.mjs', import.meta.url))], {
    cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, MIKKA_TEST_DEPLOYMENT_SHA: revision }, timeout: 5_000,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /APP_COMPILED_MANIFEST_INVALID/)
  assert.doesNotMatch(result.stderr, /SERVER_MUST_NOT_IMPORT/)
})

test('startup parameters preserve the requested authority and reject ambiguous overrides', () => {
  assert.deepEqual(serverOptions(['--hostname', 'localhost', '--port', '3100'], {}), { hostname: 'localhost', port: 3100 })
  assert.deepEqual(serverOptions([], { HOST: '127.0.0.1', PORT: '3186' }), { hostname: '127.0.0.1', port: 3186 })
  for (const args of [['--port', '0'], ['--port', '65536'], ['--port', '3000', '-p', '3001'], ['--hostname', 'https://example.com'], ['--unknown', 'value']]) {
    assert.throws(() => serverOptions(args, {}), /APP_START_/)
  }
})

test('Docker compiled entry, graph and tracing must match before any module can execute', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-docker-start-contract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.output/server'), { recursive: true })
  const source = 'throw new Error("SERVER_MUST_NOT_IMPORT")\n'
  const checksum = createHash('sha256').update(source).digest('hex')
  for (const name of ['mikka-entry', 'mikka-docker', 'docker-entry', 'mikka-tracing']) {
    await writeFile(join(root, '.output/server', `${name}.mjs`), source)
  }
  const revision = 'a'.repeat(40)
  const manifest = { version: 1, revision, testDeploymentSha: revision, preset: 'node-server',
    node: process.version, basePath: '/mikka', appBuild: revision,
    lockSha256: 'b'.repeat(64), routesSha256: 'c'.repeat(64), tracingSha256: checksum,
    docker: { entry: 'server/mikka-docker.mjs', application: 'server/docker-entry.mjs',
      entrySha256: checksum, applicationSha256: checksum, trustProxy: false } }
  const save = value => writeFile(join(root, '.output/mikka-build.json'), JSON.stringify(value))
  await save(manifest)
  assert.equal((await readCompiledDockerBuild(root, { expectedRevision: revision })).revision, revision)
  await save({ ...manifest, docker: { ...manifest.docker, trustProxy: true } })
  await assert.rejects(readCompiledDockerBuild(root, { expectedRevision: revision }), /APP_COMPILED_DOCKER_INVALID/)
  await save({ ...manifest, docker: { ...manifest.docker, entry: 'server/index.mjs' } })
  await assert.rejects(readCompiledDockerBuild(root, { expectedRevision: revision }), /APP_COMPILED_DOCKER_INVALID/)
  await save(manifest)
  for (const name of ['mikka-docker', 'docker-entry', 'mikka-tracing']) {
    await writeFile(join(root, '.output/server', `${name}.mjs`), `${source}// changed`)
    await assert.rejects(readCompiledDockerBuild(root, { expectedRevision: revision }), /APP_COMPILED_DOCKER_INVALID/)
    await writeFile(join(root, '.output/server', `${name}.mjs`), source)
  }
})
