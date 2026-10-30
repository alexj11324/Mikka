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

// Supplement only; behaviour is covered by lib/factory/run-end-paths.db.test.ts.
test('thread-machine end fires afterRunEnded after its stopped commit', async () => {
  const machines = await source('./cloud-computer/thread-machines.ts')
  const end = machines.slice(machines.indexOf("if (action === 'end') {"))
  assert.match(end.slice(0, end.indexOf("return { runId, state: 'ended' }")), /await client\.query\('COMMIT'\)[\s\S]*await afterRunEnded\(actor\.userId, runId\)/)
})
