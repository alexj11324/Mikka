#!/usr/bin/env node
// MIK-19: runs the DB-backed test scripts in CI against the e2e job's local Postgres.
// Explicit allowlist: a listed script that package.json does not define is a failure,
// and each script must run at least one test and skip none (REQUIRE_DB=1 is also set).
// Add a script here in the PR that adds its DB tests.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export const DB_TEST_SCRIPTS = ['test:issues']

/** Totals from node:test's summary (TAP `# pass 3` or spec `ℹ pass 3`). */
export function parseSummary(output) {
  const totals = {}
  for (const [, key, n] of output.matchAll(/^(?:# |ℹ )(tests|pass|fail|skipped|todo|cancelled) (\d+)\s*$/gm)) totals[key] = (totals[key] ?? 0) + Number(n)
  return totals
}

/** Returns an error string, or null when the run is acceptable. */
export function checkSummary(script, status, totals) {
  if (status !== 0) return `${script} exited with ${status}`
  if (totals.tests === undefined) return `${script}: no node:test summary found`
  if (totals.tests < 1) return `${script}: ran no tests`
  if (totals.skipped) return `${script}: ${totals.skipped} skipped (DB tests must not skip in CI)`
  if (totals.fail) return `${script}: ${totals.fail} failed`
  return null
}

function main(scripts = DB_TEST_SCRIPTS) {
  const defined = JSON.parse(readFileSync('package.json', 'utf8')).scripts ?? {}
  if (scripts.length === 0) { console.log('No DB test scripts allowlisted yet.'); return 0 }
  const missing = scripts.filter(s => !defined[s])
  if (missing.length) { console.error(`Allowlisted but not in package.json: ${missing.join(', ')}`); return 1 }
  let failed = false
  for (const script of scripts) {
    console.log(`::group::pnpm ${script}`)
    const run = spawnSync('pnpm', ['-s', script], { encoding: 'utf8', env: { ...process.env, REQUIRE_DB: '1' }, maxBuffer: 64 << 20 })
    process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '')
    console.log('::endgroup::')
    const error = checkSummary(script, run.status, parseSummary(`${run.stdout}\n${run.stderr}`))
    if (error) { console.error(`::error::${error}`); failed = true } else console.log(`${script}: OK`)
  }
  return failed ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main())
