import assert from 'node:assert/strict'
import test from 'node:test'
import { bootstrapOfficialInstance, isOfficialE2BTemplate } from './official-runtime'

const env = { MIKKA_CLOUD_WORKER_SOURCE_COMMIT: 'a'.repeat(40), MIKKA_CLOUD_WORKER_SHA: 'b'.repeat(40) }
test('official templates are explicit, and missing/invalid releases cannot run a bootstrap', async () => {
  assert.equal(isOfficialE2BTemplate('codex'), true)
  assert.equal(isOfficialE2BTemplate('private-derived-template'), false)
  const sandbox = { commands: { run: async () => { throw Error('must not execute') } } } as never
  for (const value of [{}, { ...env, MIKKA_CLOUD_WORKER_SOURCE_COMMIT: 'main' }, { ...env, MIKKA_CLOUD_WORKER_SHA: 'x; exit' }])
    await assert.rejects(bootstrapOfficialInstance(sandbox, 'codex', value), /not configured/)
})
test('a bootstrap names the immutable source and checks a receipt instead of trusting an exit code', async () => {
  const calls: string[] = []
  const sandbox = { commands: { run: async (command: string) => { calls.push(command); return { stdout: calls.length === 1 ? '' : env.MIKKA_CLOUD_WORKER_SHA } } } } as never
  await bootstrapOfficialInstance(sandbox, 'codex', env, async () => 'printf controlled-fixture')
  assert.ok(calls[0].includes(`bash -s -- ${env.MIKKA_CLOUD_WORKER_SOURCE_COMMIT} ${env.MIKKA_CLOUD_WORKER_SHA} codex`))
  assert.equal(calls[1], 'cat /opt/mikka/worker-source-sha')
  await assert.rejects(bootstrapOfficialInstance({ commands: { run: async () => ({ stdout: 'wrong receipt' }) } } as never, 'desktop', env, async () => ''), /receipt mismatch/)
})
