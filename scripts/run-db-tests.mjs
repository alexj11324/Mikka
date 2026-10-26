#!/usr/bin/env node
// MIK-19: required DB gates; only the Actions job's ephemeral PG17 is allowed.
// Inventory is tree-aware, never "missing script => skip". A feature marker requires
// its suite even if the test or package script was accidentally removed. All other
// present pg/DB files must map to an explicit recipe. Pending phases fail closed.
import { spawnSync, execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { coveragePlan, executePhase, aggregate } from './db-test-plan.mjs'

export const REQUIRED_SUITES = [
  { marker: 'lib/group-conversations-store.ts', file: 'lib/group-conversations.test.ts', script: 'test:groups' },
  { marker: 'lib/active-agents.ts', file: 'lib/active-agents.test.ts', script: 'test:active-agents' },
  { marker: 'lib/coordinator/group-turns.ts', file: 'lib/coordinator/group-turns.test.ts', script: 'test:group-turns' },
  { marker: 'lib/activity-actor.ts', file: 'tests/activity-actor-db.test.ts', script: 'test:activity-actor-db' },
  { marker: 'lib/run-visibility.ts', file: 'tests/team-visibility.db.test.ts', script: 'test:visibility-db' },
  { marker: 'lib/issue-search.ts', file: 'tests/issue-search.db.test.ts', script: 'test:issue-search-db' },
  { marker: 'tests/workspace-migration.test.mjs', file: 'tests/workspace-migration.test.mjs', script: 'test:workspace-migration-db' },
  { marker: 'lib/issue-relation-cycle.db.test.ts', file: 'lib/issue-relation-cycle.db.test.ts', script: 'test:relation-cycle' },
]
// Suites that provision their own throwaway database and refuse the shared mikka_e2e service.
// Each entry names its dedicated runner; the runner must exist and still invoke the file.
export const SELF_MANAGED = [
  { file: 'lib/auth-email.test.ts', runner: 'scripts/test-auth-email.mjs', reason: 'starts its own Docker Postgres and refuses any application database' },
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

export function inventory(files, scripts, expected, required = REQUIRED_SUITES, selfManaged = SELF_MANAGED, config = JSON.parse(readFileSync(new URL('./db-test-recipes.json', import.meta.url), 'utf8'))) {
  return coveragePlan(files, scripts, config, { required, selfManaged, expected: expected ?? config.expected })
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

export function main({ root = '.', env = process.env, run = spawnSync, args = [], commit = () => {
  execFileSync('git', ['diff', '--exit-code', 'HEAD'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['ls-files', '--error-unmatch', 'scripts/db-test-plan.mjs', 'scripts/db-test-recipes.json'], { cwd: root, stdio: 'pipe' })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
} } = {}) {
  try {
    const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts ?? {}
    const config = JSON.parse(readFileSync(resolve(root, 'scripts/db-test-recipes.json'), 'utf8'))
    const planning = args.length === 1 && args[0] === '--inventory'
    if (!planning && !env.DB_TEST_EXPECTED) throw Error('Complete DB_TEST_EXPECTED required for execution/aggregation')
    const plan = inventory(readTree(root), scripts, planning ? config.expected : env.DB_TEST_EXPECTED.split(','), REQUIRED_SUITES, SELF_MANAGED, config)
    if (planning) { console.log(JSON.stringify(plan, null, 2)); return plan.contractErrors.length ? 1 : 0 }
    const sha = commit()
    if (!/^[a-f0-9]{40}$/.test(sha) || (env.GITHUB_SHA && env.GITHUB_SHA !== sha)) throw Error('Current checkout must match exact evidence SHA')
    const outputIndex = args.indexOf('--output')
    if (outputIndex < 0 || outputIndex !== args.length - 2 || !args.at(-1)) throw Error('Explicit result --output required')
    const command = args.slice(0, outputIndex)
    let report, failed
    if (command.length === 2 && command[0] === '--phase') {
      report = executePhase(plan, command[1], sha, env, (file, argv, options) => run(file, argv, { ...options, cwd: root }))
      failed = report.results.some(r => r.state !== 'passed')
    } else if (command[0] === '--aggregate' && command.length > 1) {
      report = aggregate(plan, sha, command.slice(1).map(path => { try { return JSON.parse(readFileSync(resolve(root, path), 'utf8')) } catch { return { unreadable: path } } }))
      failed = !report.passed
    } else throw Error('Use --inventory, --phase PHASE, or --aggregate REPORTS; no implicit execution')
    const output = resolve(root, args.at(-1)); mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report))
    return failed ? 1 : 0
  } catch (error) { console.error(`::error::${error.message}`); return 1 }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main({ args: process.argv.slice(2) }))
