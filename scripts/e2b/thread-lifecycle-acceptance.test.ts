import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverAcceptanceSandboxes, validateThreadLifecycleTarget } from './thread-lifecycle-acceptance'

const isolated = () => ({ NODE_ENV: 'test', MIKKA_LOCAL_TEST_ACCOUNTS: '1',
  E2E_DATABASE_URL: 'postgresql://test:synthetic@127.0.0.1:5432/mikka_e2e', E2B_API_KEY: 'synthetic-only' })

test('provider acceptance admits the guarded disposable target and official template without returning its key', () => {
  const config = validateThreadLifecycleTarget(isolated())
  assert.equal(config.template, 'codex')
  assert.equal(config.database.hostname, '127.0.0.1')
  assert.ok(!JSON.stringify(config).includes('synthetic-only'))
})

test('provider acceptance rejects deployment, remote DB, URL override, mixed DB and unapproved template before allocation', () => {
  for (const patch of [
    { VERCEL: '1' }, { NODE_ENV: 'production' }, { WORKFLOW_TARGET_WORLD: 'production' },
    { E2E_DATABASE_URL: 'postgresql://test:synthetic@example.invalid/mikka_e2e' },
    { E2E_DATABASE_URL: isolated().E2E_DATABASE_URL + '?host=example.invalid' },
    { DATABASE_URL: 'postgresql://test:synthetic@example.invalid/production' },
    { E2B_CODEX_TEMPLATE: 'unreviewed-template' },
  ]) assert.throws(() => validateThreadLifecycleTarget({ ...isolated(), ...patch }))
})

test('only nonallocating preflight can omit the process credential', () => {
  const env: Record<string, string | undefined> = isolated(); delete env.E2B_API_KEY
  assert.throws(() => validateThreadLifecycleTarget(env))
  assert.equal(validateThreadLifecycleTarget(env, true).template, 'codex')
  assert.throws(() => validateThreadLifecycleTarget({ ...env, E2B_API_KEY: 'invalid\ncredential' }))
})

const allocation = { acceptance: 'this-invocation', sourceCommit: 'fixed-source' }
const metadata = { purpose: 'thread-lifecycle-provider-acceptance', ...allocation }
const pages = (items: Array<Array<{ sandboxId: string; metadata: Record<string, string> }>>) => {
  let next = 0
  return { get hasNext() { return next < items.length }, nextItems: async () => items[next++] }
}

test('lost create response and an empty discovery cannot become a cleanup receipt', async () => {
  const ownedIds = new Set<string>()
  await assert.rejects(discoverAcceptanceSandboxes({ ...allocation, ownedIds, list: () => pages([[]]) }),
    /acceptance_creation_cleanup_unconfirmed/)
  assert.equal(ownedIds.size, 0)
})

test('an acknowledged allocation remains an exact cleanup target when the provider list is empty', async () => {
  const ownedIds = new Set(['acknowledged-vm'])
  await discoverAcceptanceSandboxes({ ...allocation, ownedIds, list: () => pages([[]]) })
  assert.deepEqual([...ownedIds], ['acknowledged-vm'])
})

test('metadata discovery recovers only this invocation across provider pages', async () => {
  const ownedIds = new Set<string>()
  await discoverAcceptanceSandboxes({ ...allocation, ownedIds,
    list: () => pages([[], [{ sandboxId: 'recovered-vm', metadata }]]) })
  assert.deepEqual([...ownedIds], ['recovered-vm'])
})

test('foreign invocation or source metadata never authorizes cleanup of its VM', async () => {
  for (const mismatch of [{ acceptance: 'other-invocation' }, { sourceCommit: 'other-source' }, { purpose: 'other-purpose' }]) {
    const ownedIds = new Set<string>()
    await assert.rejects(discoverAcceptanceSandboxes({ ...allocation, ownedIds,
      list: () => pages([[{ sandboxId: 'foreign-vm', metadata: { ...metadata, ...mismatch } }]]) }), /Cleanup metadata mismatch/)
    assert.equal(ownedIds.size, 0)
  }
})
