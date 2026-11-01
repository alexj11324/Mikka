// Real OS sandbox regression with a synthetic claimed-run storage boundary.
// This does not replace the live model/run acceptance performed by the driver.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { defaultRunPolicy } from '../../packages/protocol/src/agent-policy.ts'
import { policySnapshotHash } from '../../packages/protocol/src/node-policy-snapshot.ts'

const root = resolve(import.meta.dirname, '../..')
test('actual read-only CLI sandbox rejects push and identical writable control succeeds', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-mvp-origin-'))
  const runId = randomUUID(), deviceId = randomUUID()
  const origin = join(directory, `mvp-${randomUUID()}`, 'origin.git')
  const seed = join(directory, 'seed'), daemon = join(directory, 'daemon')
  await mkdir(seed); await mkdir(daemon); await mkdir(resolve(origin, '..'))
  const git = args => execFileSync('git', args, { cwd: seed, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(['init', '-b', 'trunk'])
  await writeFile(join(seed, 'README.md'), 'Local sandbox fixture\n')
  git(['add', 'README.md'])
  git(['-c', 'user.name=Local acceptance', '-c', 'user.email=acceptance@example.test', 'commit', '-m', 'Seed fixture'])
  git(['clone', '--bare', seed, origin])
  const policy = { ...defaultRunPolicy(), readOnly: true }
  const policyHash = policySnapshotHash(policy), revision = 'a'.repeat(64)
  await writeFile(join(daemon, 'runs.json'), JSON.stringify({ runs: { [runId]: { assignment: { runId, deviceId, policy, policyRevision: revision, policySnapshot: { payload: { runId, deviceId, ownerId: 'synthetic-owner', revision, policyHash, policy } } } } } }), { mode: 0o600 })
  const preload = join(directory, 'synthetic-database.mjs')
  await writeFile(preload, `import pg from ${JSON.stringify(import.meta.resolve('pg'))}; pg.Pool.prototype.query=async()=>({rows:[${JSON.stringify({ userId: 'synthetic-owner', deviceId, status: 'succeeded', agentDefinition: { readOnly: true } })}]}); pg.Pool.prototype.end=async()=>{};\n`, { mode: 0o600 })
  const evidence = join(directory, 'evidence.json')
  const database = 'postgres://synthetic:synthetic@127.0.0.1/readonly_fixture_e2e'
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, '--import', 'tsx', 'scripts/dev-local/readonly-push.mjs', runId, daemon, origin, evidence], { cwd: root, env: { ...process.env, MIKKA_LOCAL_TEST_ACCOUNTS: '1', E2E_DATABASE_URL: database, MIKKA_DATABASE_URL: database, DATABASE_URL: database }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  const status = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
  assert.equal(status, 0, output)
  const result = JSON.parse(await readFile(evidence, 'utf8'))
  assert.equal(result.rejected, true)
  assert.equal(result.refsUnchanged, true)
  assert.equal(result.identicalWritableControlSucceeded, true)
  assert.equal(git(['--git-dir', origin, 'for-each-ref', '--format=%(refname)']), 'refs/heads/trunk')
})
