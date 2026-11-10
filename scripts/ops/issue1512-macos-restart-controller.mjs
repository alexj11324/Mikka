// Temporary issue1512 diagnostic controller. This file is never used by product code.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const controlRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sourceRoot = resolve(controlRoot, '../source')
const manifest = JSON.parse(await readFile(join(controlRoot, '.github/issue1512-mac-restart.json'), 'utf8'))
const artifactRoot = join(sourceRoot, 'artifacts/local-installer')
const privateRoot = join(sourceRoot, '.cache/launchctl-fixture-control')
const label = 'com.aspectlylabs.mikka.daemon'
const closedErrors = new Set(['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ENOBUFS'])
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const git = (...args) => execFileSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8', timeout: 10_000 }).trim()
const code = error => error && closedErrors.has(error.code) ? error.code : error ? 'OTHER' : null
async function save(name, value) {
  await mkdir(artifactRoot, { recursive: true })
  await writeFile(join(artifactRoot, name), JSON.stringify(value, null, 2) + '\n')
}
async function absent(path) {
  try { await lstat(path); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error }
}
function launchctl(args) {
  const startedAt = new Date().toISOString()
  const result = spawnSync('/bin/launchctl', args, { stdio: 'ignore', timeout: 10_000, killSignal: 'SIGKILL' })
  return { attempted: true, startedAt, finishedAt: new Date().toISOString(),
    exitCode: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal ?? null, errorCode: code(result.error),
    timedOut: result.error?.code === 'ETIMEDOUT' }
}
function fixedRun() {
  assert.equal(manifest.schema, 'issue1512.macos-restart-diagnostic-request.v1')
  assert.equal(manifest.enabled, true)
  assert.equal(manifest.requestId, '20261110-5852-a1')
  assert.equal(manifest.sourceCommit, '5852aa8832c07fdeef43665dd5e156ce5516e3ea')
  assert.equal(manifest.sourceTree, '42d33eb7faf77d7049607523599de9374e065660')
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1')
  assert.equal(process.platform, 'darwin')
  assert.equal(process.arch, 'arm64')
  assert.equal(process.versions.node, '22.22.1')
}
async function prepare() {
  fixedRun()
  const actualSource = git('rev-parse', 'HEAD')
  const actualTree = git('rev-parse', 'HEAD^{tree}')
  const actualControl = execFileSync('git', ['-C', controlRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).trim()
  assert.equal(actualSource, manifest.sourceCommit)
  assert.equal(actualTree, manifest.sourceTree)
  assert.equal(actualControl, process.env.GITHUB_SHA)
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '')
  assert.equal(await absent(privateRoot), true)
  const packageRoot = join(sourceRoot, 'artifacts/daemon')
  const packageBinding = JSON.parse(await readFile(join(packageRoot, 'package-binding.json'), 'utf8'))
  assert.equal(packageBinding.sourceCommit, actualSource)
  assert.equal(packageBinding.sourceTree, actualTree)
  assert.equal(packageBinding.runId, process.env.GITHUB_RUN_ID)
  assert.equal(packageBinding.attempt, 1)
  const tarballs = (await readdir(packageRoot)).filter(name => name.endsWith('.tgz'))
  assert.equal(tarballs.length, 1)
  assert.equal(packageBinding.filename, tarballs[0])
  const tarball = await readFile(join(packageRoot, tarballs[0]))
  assert.equal(packageBinding.bytes, tarball.length)
  assert.equal(packageBinding.sha256, hash(tarball))
  const paths = ['scripts/acceptance/local-installer-launchctl-diagnostic.mjs', 'scripts/acceptance/local-installer-macos.ts']
  assert.deepEqual(manifest.overlays.map(file => file.path), paths)
  const verified = []
  for (const file of manifest.overlays) {
    const destination = join(sourceRoot, file.path)
    if (file.beforeSha256 === null) assert.equal(await absent(destination), true)
    else assert.equal(hash(await readFile(destination)), file.beforeSha256)
    const bytes = await readFile(join(controlRoot, file.path))
    assert.equal(bytes.length, file.bytes)
    assert.equal(hash(bytes), file.sha256)
    verified.push({ path: file.path, bytes: file.bytes, gitBlob: file.gitBlob, sha256: file.sha256 })
  }
  for (const file of manifest.overlays) {
    await writeFile(join(sourceRoot, file.path), await readFile(join(controlRoot, file.path)), { mode: 0o644 })
  }
  await mkdir(privateRoot, { recursive: true, mode: 0o700 })
  await save('source-binding.json', { schema: 'issue1512.macos-restart-diagnostic-source.v1',
    requestId: manifest.requestId, runId: process.env.GITHUB_RUN_ID, attempt: 1,
    actualSource, actualTree, actualControl, overlays: verified,
    package: packageBinding, platform: process.platform, arch: process.arch, node: process.versions.node,
    assertions: 'All existing install/reconnect/owner/enrollment/Node assertions are retained.',
    limitation: 'Temporary wrapper adds time between commands. Diagnostic success is not a product fix or formal acceptance.' })
}
async function cleanup() {
  fixedRun()
  const receipt = { schema: 'issue1512.macos-restart-diagnostic-cleanup.v1',
    startedAt: new Date().toISOString(), ownerRecord: 'missing',
    fixtureStepOutcome: ['success', 'failure', 'cancelled', 'skipped'].includes(process.env.MIKKA_FIXTURE_STEP_OUTCOME) ? process.env.MIKKA_FIXTURE_STEP_OUTCOME : 'unknown',
    fixtureFinally: null, bootout: { attempted: false }, serviceProbe: { attempted: false },
    fixtureHomeRemoved: null, privateControlRemoved: false, status: 'partial',
    processAbsence: 'not_independently_probed',
    limitation: 'Nonzero launchctl print or bootout does not prove absence; no output text is parsed. Runner teardown is separate.' }
  let home = null
  try {
    const ownerFile = join(privateRoot, 'owned-home')
    const stat = await lstat(ownerFile)
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && stat.size < 256)
    assert.equal(stat.mode & 0o777, 0o600)
    const value = await readFile(ownerFile, 'utf8')
    assert.match(value, /^\/tmp\/mikka-i-[A-Za-z0-9]+\n$/)
    home = value.trim()
    receipt.ownerRecord = 'validated'
  } catch (error) { receipt.ownerRecord = code(error) === 'ENOENT' ? 'missing' : 'invalid' }
  try {
    const value = JSON.parse(await readFile(join(artifactRoot, 'fixture-cleanup.json'), 'utf8'))
    if (value.schema === 'issue1512.macos-fixture-cleanup.v1') {
      receipt.fixtureFinally = {
        bootout: { attempted: value.bootout?.attempted === true,
          exitCode: Number.isInteger(value.bootout?.exitCode) ? value.bootout.exitCode : null,
          error: value.bootout?.error === true },
        fixtureServerClosed: value.fixtureServerClosed === true,
        environmentRestored: value.environmentRestored === true,
        fixtureHomeRemoved: value.fixtureHomeRemoved === true,
      }
    }
  } catch {}
  if (home) {
    const target = 'gui/' + process.getuid() + '/' + label
    receipt.bootout = launchctl(['bootout', target])
    receipt.serviceProbe = launchctl(['print', target])
    try {
      // This exact directory was created by this fixture and handed off privately.
      // Never enumerate /tmp or infer other paths from launchctl output.
      if (!(await absent(home))) {
        const stat = await lstat(home)
        assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid())
      }
      await rm(home, { recursive: true, force: true })
      receipt.fixtureHomeRemoved = await absent(home)
    } catch { receipt.fixtureHomeRemoved = false }
  }
  try {
    await rm(privateRoot, { recursive: true, force: true })
    receipt.privateControlRemoved = await absent(privateRoot)
  } catch {}
  if (home && receipt.fixtureHomeRemoved && receipt.privateControlRemoved &&
      (receipt.bootout.exitCode === 0 || receipt.fixtureFinally?.bootout.exitCode === 0) &&
      Number.isInteger(receipt.serviceProbe.exitCode) && receipt.serviceProbe.exitCode !== 0) receipt.status = 'bootout_succeeded_home_removed'
  if (!home && receipt.ownerRecord === 'missing' && receipt.privateControlRemoved && receipt.fixtureStepOutcome === 'skipped') receipt.status = 'fixture_not_started'
  receipt.finishedAt = new Date().toISOString()
  await save('controller-cleanup.json', receipt)
  console.log(JSON.stringify(receipt))
  if (receipt.status === 'partial') process.exitCode = 1
}
const mode = process.argv[2]
try {
  if (mode === 'prepare') await prepare()
  else if (mode === 'cleanup') await cleanup()
  else throw new Error('Unknown diagnostic controller mode')
} catch (error) {
  console.error(JSON.stringify({ schema: 'issue1512.macos-diagnostic-controller-error.v1',
    mode: mode === 'prepare' || mode === 'cleanup' ? mode : 'unknown',
    errorCode: code(error), errorName: error?.name === 'AssertionError' ? 'AssertionError' : 'Error',
    failed: true }))
  process.exitCode = 1
}
