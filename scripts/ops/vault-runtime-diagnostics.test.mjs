import test from 'node:test'
import assert from 'node:assert/strict'
test('fixture observer preserves exact request, Promise and response without reading values', async () => {
  const previousFetch = globalThis.fetch, previousLog = console.log, previousFlag = process.env.MIKKA_VAULT_DIAGNOSTICS
  const logs = [], response = new Response('private-body'), promise = Promise.resolve(response)
  const url = 'https://6082-owned.e2b.app/agents/00000000-0000-4000-8000-000000000001/credentials/begin?token=private-query'
  const init = { method: 'POST', headers: { authorization: 'private-header' }, body: 'private-request' }
  try {
    process.env.MIKKA_VAULT_DIAGNOSTICS = '1'
    globalThis.fetch = (input, options) => { assert.equal(input, url); assert.equal(options, init); return promise }
    console.log = value => logs.push(value)
    await import('./vault-runtime-diagnostics.mjs?enabled')
    assert.equal(globalThis.fetch(url, init), promise)
    assert.equal(await promise, response); await new Promise(resolve => setImmediate(resolve))
    assert.equal(response.bodyUsed, false)
    assert.deepEqual(logs.map(JSON.parse), [{ kind: 'vault_runtime_boundary', route: 'credentials/begin', status: 200 }])
    assert.equal(logs.join('').includes('private'), false)
  } finally {
    globalThis.fetch = previousFetch; console.log = previousLog
    if (previousFlag === undefined) delete process.env.MIKKA_VAULT_DIAGNOSTICS; else process.env.MIKKA_VAULT_DIAGNOSTICS = previousFlag
  }
})
test('observer remains absent outside the explicit disposable fixture', async () => {
  const previous = process.env.MIKKA_VAULT_DIAGNOSTICS, original = globalThis.fetch
  try { delete process.env.MIKKA_VAULT_DIAGNOSTICS; await import('./vault-runtime-diagnostics.mjs?disabled'); assert.equal(globalThis.fetch, original) }
  finally { if (previous !== undefined) process.env.MIKKA_VAULT_DIAGNOSTICS = previous }
})
