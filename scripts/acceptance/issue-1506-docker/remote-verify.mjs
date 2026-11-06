import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const [manifestPath, reportPath, worktree] = process.argv.slice(2)
const BASE = 'e8dd7a1265027a0477819dde1a80178e7bcdb1ae'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const report = { schemaVersion: 1, issue: 1506, status: 'failed', baseSha: BASE, worktree,
  bootstrapPassed: false, productionRequests: 0, sourceHashes: {}, checks: [] }
const secrets = ['E2E_DATABASE_URL', 'MIKKA_DATABASE_URL', 'DATABASE_URL', 'BETTER_AUTH_SECRET'].flatMap(key => {
  const value = process.env[key]
  if (!value) return []
  try { const url = new URL(value); return [value, decodeURIComponent(url.password)].filter(Boolean) } catch { return [value] }
})
const redact = value => {
  let text = String(value ?? '')
  for (const secret of secrets.filter(value => value.length >= 4).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]')
  return text.replace(/(postgres(?:ql)?:\/\/[^\s:/]+:)[^\s@]+(@)/gi, '$1[redacted]$2')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
}
const save = () => { writeFileSync(reportPath + '.tmp', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); renameSync(reportPath + '.tmp', reportPath) }
const fail = code => { throw new Error(code) }
const CHECKS = [
  ['git-diff-check', ['git', 'diff', '--cached', '--check']],
  ['stop-unit', ['node', '--experimental-test-module-mocks', '--import', './tests/support/server-only.mjs', '--import', 'tsx', '--test',
    'lib/agent-kit/core-entry.test.ts', 'lib/subscription-workflow-turn.test.ts', 'lib/agent-kit/agent-kit.test.ts']],
  ['stop-database', ['node', '--experimental-test-module-mocks', '--import', './scripts/server-test.mjs', '--import', 'tsx', '--test', 'lib/agent-kit/store.db.test.ts']],
  ['live-unit', ['node', '--import', 'tsx', '--test', 'lib/live/channel.test.ts', 'lib/live/tab-share.test.ts']],
  ['live-hooks', ['pnpm', 'test:live-lists']],
  ['typecheck', ['pnpm', 'typecheck']],
  ['lint', ['pnpm', 'lint']],
  ['polling-policy', ['node', 'scripts/polling-policy.mjs']],
  ['idle-budget', ['pnpm', 'test:idle-budget']],
]
try {
  if (!/^\/workspace\/Mikka-1506-verify-\d{1,24}-\d{1,4}$/.test(worktree ?? '') || process.cwd() !== worktree ||
    !/^\/tmp\/mikka-1506-\d{1,24}-\d{1,4}-report.json$/.test(reportPath ?? '')) fail('worktree_scope_invalid')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.baseSha !== BASE || spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() !== BASE) fail('base_version_mismatch')
  for (const key of ['E2E_DATABASE_URL', 'MIKKA_DATABASE_URL', 'DATABASE_URL']) {
    const url = new URL(process.env[key] ?? '')
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== '5432' || url.pathname !== '/mikka_e2e') fail('isolated_database_required')
  }
  if (process.env.MIKKA_LOCAL_TEST_ACCOUNTS !== '1' || Number(process.versions.node.split('.')[0]) !== 24) fail('bootstrap_environment_invalid')
  report.bootstrapPassed = true
  report.nodeVersion = process.versions.node
  report.bootstrapStderr = redact(readFileSync(reportPath + '.bootstrap-stderr', 'utf8'))
  const expected = Object.assign({}, ...manifest.patches.map(patch => patch.sources))
  for (const [path, expectedHash] of Object.entries(expected)) {
    const full = resolve(worktree, path)
    if (!full.startsWith(worktree + '/') || !lstatSync(full).isFile() || lstatSync(full).isSymbolicLink()) fail('source_path_invalid')
    report.sourceHashes[path] = hash(readFileSync(full))
    if (report.sourceHashes[path] !== expectedHash) fail('source_hash_mismatch')
  }
  const changed = spawnSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' })
  if (changed.status !== 0 || JSON.stringify(changed.stdout.trim().split('\n').sort()) !== JSON.stringify(Object.keys(expected).sort())) fail('source_inventory_mismatch')
  report.sourceDigest = hash(JSON.stringify(Object.entries(report.sourceHashes).sort(([a], [b]) => a.localeCompare(b))))
  const deadline = Date.now() + 780_000
  for (const [name, command] of CHECKS) {
    const remaining = deadline - Date.now()
    if (remaining <= 1000) fail('checks_deadline')
    const started = Date.now()
    const result = spawnSync(command[0], command.slice(1), { cwd: worktree, env: { ...process.env, CI: '1', NODE_ENV: 'test' },
      encoding: 'utf8', timeout: Math.min(remaining, 360_000), killSignal: 'SIGTERM', maxBuffer: 24_000_000 })
    report.checks.push({ name, command, exitCode: Number.isInteger(result.status) ? result.status : 124,
      signal: ['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV'].includes(result.signal) ? result.signal : null,
      stdout: redact(result.stdout), stderr: redact(result.stderr), durationMs: Date.now() - started,
      ...(result.error ? { error: result.error.code === 'ETIMEDOUT' ? 'command_timeout' : 'command_execution_failed' } : {}) })
    save()
  }
  // Source-only gates must not edit the reviewed candidate as a side effect.
  if (Object.entries(expected).some(([path, sha]) => hash(readFileSync(join(worktree, path))) !== sha)) fail('source_changed_during_checks')
  report.status = report.checks.every(check => check.exitCode === 0) ? 'passed' : 'failed'
} catch (error) {
  const codes = new Set(['worktree_scope_invalid', 'base_version_mismatch', 'isolated_database_required', 'bootstrap_environment_invalid',
    'source_path_invalid', 'source_hash_mismatch', 'source_inventory_mismatch', 'checks_deadline', 'source_changed_during_checks'])
  report.error = codes.has(error?.message) ? error.message : 'remote_verification_failed'
} finally {
  save()
  console.log(JSON.stringify({ schemaVersion: 1, status: report.status, checkCount: report.checks.length, sourceDigest: report.sourceDigest ?? null }))
  process.exitCode = report.status === 'passed' ? 0 : 1
}
