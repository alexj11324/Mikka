import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { credentialProbeCommand, credentialScrubCommand, runCredentialGlobs, SNAPSHOT_CREDENTIAL_GLOBS } from '../../packages/daemon/src/credential-globs'

// Decision 2026-10-31-2225: a cloud snapshot holds software only, never a credential.
const actor = { userId: 'owner', workspaceId: '10000000-0000-4000-8000-000000000001' } as never
const revision = 'a'.repeat(40)
function fixture(found: string[], old?: { snapshotId: string }) {
  const calls = { snapshots: 0, inserts: 0, probes: [] as string[] }
  const pool = { query: async (sql: string) => {
    if (sql.startsWith('SELECT')) return { rows: old ? [{ ...old, sourceRevision: 'b'.repeat(40), lockDigest: 'stale', createdAt: new Date(0) }] : [] }
    calls.inserts++
    return { rows: [] }
  } }
  const source = {
    commands: { run: async (command: string) => {
      if (command.includes('rev-parse')) return { stdout: `${revision}\n` }
      if (command.includes('sha256sum')) return { stdout: '' }
      calls.probes.push(command)
      return { stdout: found.map(path => `${path}\n`).join('') }
    } },
    createSnapshot: async () => { calls.snapshots++; return { snapshotId: 'fresh' } },
  }
  return { pool: pool as never, source, calls }
}

test('a clean bot machine is snapshotted, after the credential probe', async () => {
  const { workspaceSnapshot } = await import('./thread-machines')
  const { pool, source, calls } = fixture([])
  assert.equal(await workspaceSnapshot(pool, actor, source as never, '/repo'), 'fresh')
  assert.deepEqual([calls.probes.length, calls.snapshots, calls.inserts], [1, 1, 1])
  assert.equal(calls.probes[0], credentialProbeCommand())
})

test('credentials on the bot machine: no new snapshot; the last clean one is reused, or the thread is refused', async () => {
  const { workspaceSnapshot } = await import('./thread-machines')
  const present = ['/home/user/.claude/.credentials.json']
  const reused = fixture(present, { snapshotId: 'clean-earlier' })
  assert.equal(await workspaceSnapshot(reused.pool, actor, reused.source as never, '/repo'), 'clean-earlier')
  assert.deepEqual([reused.calls.snapshots, reused.calls.inserts], [0, 0])
  const none = fixture(present)
  await assert.rejects(workspaceSnapshot(none.pool, actor, none.source as never, '/repo'), { status: 409, message: 'Workspace snapshot unavailable' })
  assert.equal(none.calls.snapshots, 0)
})

test('the probe finds and the scrub removes exactly the credential paths, in a real shell', () => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-credentials-'))
  const state = join(root, 'adapters')
  const files = [
    join(root, 'home', 'runner', '.claude', '.credentials.json'),
    join(root, 'home', 'runner', '.codex', 'auth.json'),
    join(state, 'runs', 'run-1', 'github', 'config.json.cache'),
    join(state, 'native-brokers', 'native-broker-1', 'broker.sock'),
  ]
  const keep = [join(state, 'runs', 'run-1', 'runtime-git', 'HEAD'), join(root, 'home', 'runner', '.claude', 'settings.json')]
  for (const file of [...files, ...keep]) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, 'x') }
  const globs = [`${root}/home/*/.claude/.credentials.json`, `${root}/home/*/.codex/auth.json`, ...runCredentialGlobs(state)]
  const found = execFileSync('sh', ['-c', credentialProbeCommand(globs)], { encoding: 'utf8' }).split('\n').filter(Boolean).sort()
  assert.deepEqual(found, [files[0], files[1], join(state, 'runs', 'run-1', 'github'), join(state, 'native-brokers', 'native-broker-1')].sort())
  execFileSync('sh', ['-c', credentialScrubCommand(globs)])
  for (const file of files) assert.equal(existsSync(file), false, file)
  for (const file of keep) assert.equal(existsSync(file), true, `${file} is not a credential`)
  assert.equal(execFileSync('sh', ['-c', credentialProbeCommand(globs)], { encoding: 'utf8' }), '')
})

test('the list covers coding-CLI logins, run GitHub tokens and live brokers, and refuses an unsafe path', () => {
  for (const path of ['/home/*/.claude/.credentials.json', '/home/*/.codex/auth.json', '/root/.claude/.credentials.json', '/root/.codex/auth.json', '/home/user/.mikka/worker/adapters/runs/*/github', '/home/user/.mikka/worker/adapters/native-brokers/*'])
    assert.ok(SNAPSHOT_CREDENTIAL_GLOBS.includes(path), path)
  assert.throws(() => credentialProbeCommand(['/tmp/x; rm -rf /']), /Unsafe/)
})
