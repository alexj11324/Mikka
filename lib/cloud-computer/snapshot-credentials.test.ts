import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { credentialProbeCommand, credentialScrubCommand, runCredentialGlobs, SNAPSHOT_CREDENTIAL_GLOBS } from '../../packages/daemon/src/credential-globs'

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
  for (const path of ['/home/*/.claude/.credentials.json', '/home/*/.codex/auth.json', '/root/.claude/.credentials.json', '/root/.codex/auth.json',
    '/home/user/.mikka/worker/adapters/runs/*/github', '/home/user/.mikka/worker/adapters/native-brokers/*',
    '/home/user/.mikka/bootstrap.json', '/home/user/.mikka/anonymous-claude.json', '/home/user/.mikka/anonymous-codex.json'])
    assert.ok(SNAPSHOT_CREDENTIAL_GLOBS.includes(path), path)
  assert.throws(() => credentialProbeCommand(['/tmp/x; rm -rf /']), /Unsafe/)
})
