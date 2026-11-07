import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverAcceptanceSandboxes, observeProviderRequestDeadline, validateThreadLifecycleTarget } from './thread-lifecycle-acceptance'

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

test('the request deadline observer gives the controller the original native TimeoutError and returns only closed evidence', async () => {
  const failure = new DOMException('private-provider-message', 'TimeoutError')
  const due = Date.now() + 5000
  let attempts = 0
  const evidence = await observeProviderRequestDeadline(async (...args) => {
    assert.deepEqual(args, ['owned-vm', 'owned-user', 900_000]); attempts++; throw failure
  }, async renew => {
    await assert.rejects(renew('owned-vm', 'owned-user', 900_000), error => error === failure)
    return due
  })
  assert.equal(attempts, 1)
  assert.deepEqual(evidence, { retryAt: due, errorName: 'TimeoutError' })
  assert.ok(!JSON.stringify(evidence).includes('private-provider-message'))
})

test('a request that beats its deadline is inconclusive even when the controller reports a future deadline', async () => {
  let attempts = 0
  await assert.rejects(observeProviderRequestDeadline(async () => { attempts++ }, async renew => {
    await renew('owned-vm', 'owned-user', 900_000)
    return Date.now() + 300_000
  }), /acceptance_request_deadline_inconclusive/)
  assert.equal(attempts, 1)
})

test('cancellation, provider refusal and a non-native TimeoutError cannot satisfy the actual deadline case', async () => {
  for (const failure of [new DOMException('private-cancellation', 'AbortError'),
    Object.assign(new Error('private-provider-body'), { status: 503 }),
    Object.assign(new Error('private-rpc-timeout'), { name: 'TimeoutError' })]) {
    await assert.rejects(observeProviderRequestDeadline(async () => { throw failure }, async renew => {
      await assert.rejects(renew('owned-vm', 'owned-user', 900_000), error => error === failure)
      return Date.now() + 5000
    }), error => error instanceof Error && error.message === 'acceptance_request_deadline_unexpected_error' && error.cause === failure)
  }
})

test('a missing request or failed controller persistence cannot produce deadline evidence', async () => {
  await assert.rejects(observeProviderRequestDeadline(async () => { assert.fail('request must not run') },
    async () => Date.now() + 5000), /acceptance_request_deadline_attempt_count/)
  const timeout = new DOMException('private-timeout', 'TimeoutError'), databaseFailure = new Error('private-database-error')
  await assert.rejects(observeProviderRequestDeadline(async () => { throw timeout }, async renew => {
    await assert.rejects(renew('owned-vm', 'owned-user', 900_000), error => error === timeout)
    throw databaseFailure
  }), error => error === databaseFailure)
})
