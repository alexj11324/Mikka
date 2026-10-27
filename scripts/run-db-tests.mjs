#!/usr/bin/env node
// MIK-19: required DB gates; only the Actions job's ephemeral PG17 is allowed.
// Inventory is tree-aware, never "missing script => skip". A feature marker requires
// its suite even if the test or package script was accidentally removed. All other
// present pg/DB test files must map to a package script or inventory fails closed.
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const REQUIRED_SUITES = [
  { marker: 'lib/credentials/store.ts', file: 'lib/credentials/store.db.test.ts', script: 'test:credentials-db' },
  { marker: 'lib/computer/store.ts', file: 'lib/computer/store.db.test.ts', script: 'test:computer-db' },
  { marker: 'lib/group-conversations-store.ts', file: 'lib/group-conversations.test.ts', script: 'test:groups' },
  { marker: 'lib/active-agents.ts', file: 'lib/active-agents.test.ts', script: 'test:active-agents' },
  { marker: 'lib/coordinator/group-turns.ts', file: 'lib/coordinator/group-turns.test.ts', script: 'test:group-turns' },
  { marker: 'lib/coordinator/bot-instructions.ts', file: 'lib/coordinator/bot-chats.db.test.ts', script: 'test:bot-chats-db' },
  { marker: 'lib/coordinator/native-store.ts', file: 'lib/coordinator/native-store.test.ts', script: 'test:coordinator-native' },
  { marker: 'lib/activity-actor.ts', file: 'tests/activity-actor-db.test.ts', script: 'test:activity-actor-db' },
  { marker: 'lib/run-visibility.ts', file: 'tests/team-visibility.db.test.ts', script: 'test:visibility-db' },
  { marker: 'lib/issue-search.ts', file: 'tests/issue-search.db.test.ts', script: 'test:issue-search-db' },
  { marker: 'tests/workspace-migration.test.mjs', file: 'tests/workspace-migration.test.mjs', script: 'test:workspace-migration-db' },
  { marker: 'drizzle/20261027164500_artifact_legacy_compat.sql', file: 'tests/artifact-legacy-migration.test.mjs', script: 'test:artifact-migration-db' },
  { marker: 'lib/issue-relation-cycle.db.test.ts', file: 'lib/issue-relation-cycle.db.test.ts', script: 'test:relation-cycle' },
]
// Suites that provision their own throwaway database and refuse the shared mikka_e2e service.
// Each entry names its dedicated runner; the runner must exist and still invoke the file.
export const SELF_MANAGED = [
  { file: 'lib/auth-email.test.ts', runner: 'scripts/test-auth-email.mjs', reason: 'starts its own Docker Postgres and refuses any application database' },
  { file: 'tests/byos-application.test.mjs', runner: 'scripts/test-subscription-worker.mjs', reason: 'starts an isolated BYOS Postgres and worker fixture' },
  { file: 'tests/byos-enrollment-binding.test.mjs', runner: 'scripts/test-subscription-worker.mjs', reason: 'starts an isolated BYOS Postgres and worker fixture' },
]
// This destructive empty-database bootstrap must stay BEFORE test:e2e:setup.
// Its workflow invocation is independently checked, not silently omitted.
export const BOOTSTRAP = 'tests/migrate-empty-db.test.mjs'

export function parseSummary(output) {
  const totals = {}
  for (const [, key, n] of output.matchAll(/^(?:# |ℹ )(tests|pass|fail|skipped|todo|cancelled) (\d+)\s*$/gm)) totals[key] = (totals[key] ?? 0) + Number(n)
  return totals
}
export function checkSummary(script, status, totals) {
  if (status !== 0) return `${script} exited with ${status}`
  if (!Number.isInteger(totals.tests)) return `${script}: no node:test summary found`
  if (totals.tests < 1) return `${script}: ran no tests`
  for (const key of ['skipped', 'todo', 'fail', 'cancelled']) if (totals[key]) return `${script}: ${totals[key]} ${key} (forbidden in required DB gates)`
  if (totals.pass !== totals.tests) return `${script}: passed count does not equal test count`
  return null
}

export function validateTarget(env) {
  if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true') throw new Error('DB gates require GitHub Actions ephemeral PG17')
  let url
  try { url = new URL(env.E2E_DATABASE_URL) } catch { throw new Error('Missing/invalid E2E_DATABASE_URL') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== '5432' || url.pathname !== '/mikka_e2e' || url.search || url.hash) throw new Error('DB gates require the loopback mikka_e2e service without URL options')
  for (const name of ['MIKKA_DATABASE_URL', 'DATABASE_URL']) if (env[name] !== env.E2E_DATABASE_URL) throw new Error(`${name} must match the ephemeral E2E_DATABASE_URL`)
  if (env.ORVILO_DATABASE_URL && env.ORVILO_DATABASE_URL !== env.E2E_DATABASE_URL) throw new Error('Legacy database fallback must not point outside ephemeral service')
}

export function inventory(files, scripts, expected = [], required = REQUIRED_SUITES, selfManaged = SELF_MANAGED) {
  const has = path => Object.hasOwn(files, path)
  const selected = new Set()
  const covered = new Set()
  const commandHas = (command, file) => command?.split(/\s+/).includes(file)
  const excluded = new Set()
  for (const { file, runner, reason } of selfManaged) {
    if (!has(file)) continue
    if (!reason) throw new Error(`Self-managed DB suite ${file} needs a reason`)
    if (!files[runner]?.includes(file)) throw new Error(`Self-managed DB suite ${file}: runner ${runner} missing or no longer runs it`)
    if (required.some(suite => suite.file === file)) throw new Error(`DB suite ${file} cannot be both required and self-managed`)
    excluded.add(file)
  }
  for (const { marker, file, script } of required) {
    if (!has(marker) && !has(file) && !expected.includes(script)) continue
    if (!has(file)) throw new Error(`Expected DB suite missing: ${file} (${marker})`)
    if (!commandHas(scripts[script], file)) throw new Error(`Required script ${script} missing or no longer runs ${file}`)
    selected.add(script); covered.add(file)
  }
  for (const [file, source] of Object.entries(files)) {
    // Playwright DB fixtures run in the preserved server-backed browser/performance gates.
    if (!/\.(test|spec)\.(ts|mjs|js)$/.test(file) || file === BOOTSTRAP || file === 'scripts/run-db-tests.test.mjs' || file.startsWith('tests/e2e/')) continue
    const databaseBacked = /(?:\.db\.test\.|-db\.test\.)/.test(file) || /(?:from\s*['"]pg['"]|import\(['"]pg['"]\)|REQUIRE_DB|CONVERSATION_READS_REQUIRE_DB)/.test(source)
    if (!databaseBacked || covered.has(file) || excluded.has(file)) continue
    const matches = Object.entries(scripts).filter(([name, command]) => name.startsWith('test:') && commandHas(command, file))
    if (matches.length !== 1) throw new Error(`DB test ${file} needs one explicit package test script (found ${matches.length})`)
    selected.add(matches[0][0]); covered.add(file)
  }
  for (const name of expected) {
    if (!selected.has(name)) throw new Error(`Expected DB script not enrolled: ${name}`)
  }
  if (!selected.size) throw new Error('No database suites enrolled')
  return { scripts: [...selected].sort(), files: [...covered].sort(), selfManaged: [...excluded].sort() }
}

export function readTree(root = '.') {
  const files = {}
  const walk = dir => {
    if (!existsSync(resolve(root, dir))) return
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(file)
      else if (/\.(ts|mjs|js)$/.test(file)) files[file] = readFileSync(resolve(root, file), 'utf8')
    }
  }
  walk('lib'); walk('tests'); walk('scripts')
  return files
}

export function main({ root = '.', env = process.env, run = spawnSync } = {}) {
  try {
    validateTarget(env)
    const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts ?? {}
    const plan = inventory(readTree(root), scripts, (env.DB_TEST_EXPECTED ?? '').split(',').filter(Boolean))
    console.log(`Required DB inventory: ${JSON.stringify(plan)}`)
    let failed = false
    for (const script of plan.scripts) {
      console.log(`::group::pnpm ${script}`)
      const result = run('pnpm', ['-s', script], { cwd: root, encoding: 'utf8', env: { ...env, REQUIRE_DB: '1', CONVERSATION_READS_REQUIRE_DB: '1', MIKKA_TEST_DB_PORT: '5432' }, maxBuffer: 64 << 20 })
      process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '')
      console.log('::endgroup::')
      const error = checkSummary(script, result.status, parseSummary(`${result.stdout}\n${result.stderr}`))
      if (error) { console.error(`::error::${error}`); failed = true }
      else console.log(`${script}: OK`)
    }
    return failed ? 1 : 0
  } catch (error) { console.error(`::error::${error.message}`); return 1 }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main())
