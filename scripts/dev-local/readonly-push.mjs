// Deterministic negative action through the real run sandbox. The model is
// allowed to obey its read-only instructions; this CLI tests enforcement.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import pg from 'pg'
import { execa } from '../../packages/daemon/node_modules/execa/index.js'
import { assertDevLocal } from './guard.mjs'
import { RunContext } from '../../packages/daemon/src/agents/run-context.ts'
import { SandboxRuntime } from '../../packages/daemon/src/agents/sandbox.ts'
import { localGitOrigin } from '../../packages/daemon/src/agents/local-git-origin.ts'
import { ensureSandboxTools } from '../../packages/daemon/src/sandbox-tools.ts'
import { policySnapshotHash } from '../../packages/protocol/src/node-policy-snapshot.ts'

assertDevLocal(process.env)
const [runId, daemonDir, originPath, outputFile] = process.argv.slice(2)
assert.match(runId ?? '', /^[a-f0-9-]{36}$/)
const origin = resolve(originPath), directory = join(resolve(outputFile, '..'), `readonly-${runId}`)
process.env.MIKKA_DEV_GIT_ORIGIN = origin
assert.equal(localGitOrigin(), origin, 'Only the owning dev:local fixture origin is permitted')
const db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1, statement_timeout: 10_000 })
const sandbox = new SandboxRuntime()
const branch = `refs/heads/acceptance-readonly-${runId}`
const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const refs = () => git(['--git-dir', origin, 'for-each-ref', '--format=%(refname):%(objectname)'])
let before
try {
  const { rows: [run] } = await db.query('SELECT "userId","deviceId","agentDefinition",status FROM agent_runs WHERE id=$1', [runId])
  assert.equal(run?.agentDefinition?.readOnly, true, 'Real dispatched definition is not read-only')
  assert.equal(run.status, 'succeeded', 'Model read-only run did not complete successfully')
  // This host-owned journal is the exact assignment consumed by the daemon.
  // Only its non-secret policy is used; credentials never enter the child env
  // or evidence. No request depends on an expired run token or live lease.
  const assignment = JSON.parse(await readFile(join(daemonDir, 'runs.json'), 'utf8')).runs[runId]?.assignment
  assert.equal(assignment?.runId, runId)
  assert.equal(assignment.deviceId, run.deviceId)
  assert.equal(assignment.policy?.readOnly, true)
  const signed = assignment.policySnapshot?.payload
  assert.ok(signed, 'Claimed run has no frozen signed policy')
  assert.equal(signed.runId, runId)
  assert.equal(signed.ownerId, run.userId)
  assert.equal(signed.deviceId, run.deviceId)
  assert.equal(signed.revision, assignment.policyRevision)
  assert.equal(signed.policyHash, policySnapshotHash(assignment.policy))
  assert.deepEqual(signed.policy, assignment.policy)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const dependencies = await ensureSandboxTools({ dataDir: daemonDir, log: { info() {}, warn() {} } })
  assert.deepEqual(dependencies, [], 'Real sandbox dependencies are missing')
  await sandbox.probe()
  const worktree = join(directory, 'worktree')
  git(['clone', '--no-hardlinks', origin, worktree])
  await writeFile(join(worktree, 'READONLY_PROBE.md'), `Read-only enforcement ${runId}\n`)
  git(['-C', worktree, 'add', 'READONLY_PROBE.md'])
  git(['-C', worktree, '-c', 'user.name=Local acceptance', '-c', 'user.email=acceptance@example.test', 'commit', '-m', `Read-only probe ${runId}`])
  before = refs()
  const privateDir = join(directory, 'private')
  await mkdir(privateDir, { mode: 0o700 })
  const makeContext = (name, policy, github) => new RunContext({ harness: 'claude_code', kind: 'implement', worktree, runDir: join(directory, name), privateDir, policy, ...(github ? { github } : {}) })
  const context = makeContext('read-only', assignment.policy)
  assert.ok(context.policy().denyWrite.includes(worktree), 'RunContext did not make the worktree read-only')
  assert.ok(!context.policy().allowWrite.includes(origin), 'Read-only run gained origin write authority')
  const push = async current => {
    // This action uses a file origin and no network. Keep networking closed in
    // both controls, including when the real run allowed an unrestricted '*'
    // (which sandbox-runtime intentionally refuses as a literal domain).
    const wrapped = await sandbox.wrap(['git', '-C', worktree, 'push', origin, `HEAD:${branch}`], { ...current.policy(), allowDomains: [] })
    try {
      const result = await execa('/bin/sh', ['-c', wrapped.command], { reject: false, timeout: 20_000, extendEnv: false, env: { PATH: process.env.PATH, HOME: current.runDir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...current.tempEnv() } })
      return { exitCode: result.exitCode, timedOut: result.timedOut, reason: wrapped.annotate(result.stderr) }
    } finally { wrapped.release() }
  }
  const rejected = await push(context)
  assert.notEqual(rejected.exitCode, 0, 'Read-only sandbox permitted git push')
  assert.equal(rejected.timedOut, false, 'Read-only push failed by timeout instead of authorization')
  assert.match(rejected.reason, /permission denied|read.only file system|operation not permitted|sandbox.*(denied|violation)|unpack.*(failed|error)|unable to create temporary object directory/i, 'Push did not fail for a filesystem authorization reason')
  assert.equal(refs(), before, 'Rejected push changed remote refs')
  // The same command succeeds when only the read-only restriction is removed
  // and the fixture's normal writable grant is applied. This excludes network,
  // credentials, missing tools and unavailable-origin failures from the proof.
  const writable = { ...assignment.policy, readOnly: false, permissions: { ...assignment.policy.permissions, git_push: 'allow' } }
  const control = makeContext('write-control', writable, { endpoint: 'http://localhost:3110/mikka/api/runs/github-token', repository: 'mikka-e2e/core-loop', branch: branch.slice('refs/heads/'.length), runToken: 'synthetic-local-control', issueId: run.agentDefinition.repositoryAdmission?.issueId ?? runId })
  assert.ok(control.policy().allowWrite.includes(origin))
  const allowed = await push(control)
  assert.equal(allowed.exitCode, 0, 'The writable sandbox control could not push to the same local origin')
  git(['--git-dir', origin, 'update-ref', '-d', branch])
  assert.equal(refs(), before, 'Control cleanup changed pre-existing remote refs')
  await writeFile(outputFile, JSON.stringify({ runId, frozenReadOnly: true, policyHash: signed.policyHash, revision: signed.revision, rejected: true, authorizationReason: rejected.reason.slice(-2000), refsUnchanged: true, identicalWritableControlSucceeded: true, scope: 'Actual claimed run policy + real SandboxRuntime CLI action; separate from model prose' }, null, 2), { mode: 0o600 })
  console.log('Read-only actual sandbox push rejected; writable control passed; remote refs restored')
} finally {
  await sandbox.reset()
  if (before !== undefined) {
    // This name is unique to this invocation and never a product branch.
    try { git(['--git-dir', origin, 'update-ref', '-d', branch]) } catch { /* Evidence reports the original failure. */ }
  }
  await db.end()
}
