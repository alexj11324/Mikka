// QA #449: every path that ends a Factory-bound run (or asks it to stop) goes through
// the shared afterRunEnded entry point, not only the daemon completion route.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')
test('claim route: the blockQuestionRetry (questions/retry.ts) end fires afterRunEnded before the 409', async () => {
  const route = await source('../app/v1/devices/[deviceId]/runs/[runId]/claim/route.ts')
  const line = route.split('\n').find((l) => l.includes('blockQuestionRetry('))
  assert.ok(line && /blockQuestionRetry\([^)]*\) && \(await afterRunEnded\(caller\.userId, runId\), true\)\) return/.test(line), 'retry block must call afterRunEnded')
  assert.ok((route.match(/await afterRunEnded\(/g) ?? []).length >= 3, 'every claim-side failure end fires afterRunEnded')
})

test('lease expiry and device-lost retry both fire afterRunEnded', async () => {
  const leases = await source('./run-leases.ts')
  const announce = leases.slice(leases.indexOf('async function announceEnd'))
  assert.match(announce.slice(0, announce.indexOf('\n}')), /await afterRunEnded\(run\.userId, run\.id\)/)
  assert.match(leases.slice(leases.indexOf('if (retried) {'), leases.indexOf('if (retried) {') + 200), /await afterRunEnded\(run\.userId, run\.id\)/)
})

test('requestRunStop (run-control cancel path) fires afterRunEnded right after stopOwnedRun', async () => {
  const runs = await source('./agent-runs.ts')
  const start = runs.indexOf('export async function requestRunStop(')
  assert.ok(start >= 0)
  const body = runs.slice(start, runs.indexOf('\n}', start))
  assert.match(body, /await stopOwnedRun\(db, userId, parsed\.data\)\s*\n\s*await afterRunEnded\(userId, parsed\.data\)/)
  for (const caller of ['../app/actions/agents.ts', './mcp/actions.ts']) {
    const text = await source(caller)
    assert.ok(!/stopOwnedRun\(/.test(text), `${caller} must stop runs via requestRunStop, not stopOwnedRun`)
  }
})
