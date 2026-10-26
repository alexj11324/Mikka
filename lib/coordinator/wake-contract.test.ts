import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { controlledWakeConfiguration } from './wake-controlled'

test('an uncaptured workspace cannot acquire default resource admission', async () => {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return specifier === 'server-only'
        ? { url: 'data:text/javascript,export{}', shortCircuit: true }
        : next(specifier, context)
    },
  })
  const { resourceWakeAdmission } = await import('./wake-admission')
  hooks.deregister()
  const before = Date.now()
  const result = await resourceWakeAdmission(
    { ownerId: 'synthetic', workspaceId: null, operationId: 'synthetic-operation', generation: 0 },
    'dispatch',
  )
  assert.equal(result.admitted, false)
  if (!result.admitted) assert.ok(result.retryAt.getTime() >= before + 60000)
})
test('controlled transport rejects cloud/provider credentials and non-isolated configuration', () => {
  const settings = {
    MIKKA_WAKE_CONTROLLED_ORIGIN: 'http://127.0.0.1:6176',
    MIKKA_WAKE_CONTROLLED_TOKEN: 'synthetic-test-only',
    MIKKA_DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/test_176',
    CI: 'true',
    VERCEL: undefined,
    AI_GATEWAY_API_KEY: undefined,
    DECISION_GATEWAY_API_KEY: undefined,
    OPENCODE_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
  }
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]))
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  try {
    apply(settings)
    assert.ok(controlledWakeConfiguration())
    for (const key of [
      'VERCEL',
      'AI_GATEWAY_API_KEY',
      'DECISION_GATEWAY_API_KEY',
      'OPENCODE_API_KEY',
      'OPENAI_API_KEY',
    ]) {
      apply({ ...settings, [key]: 'synthetic' })
      assert.throws(controlledWakeConfiguration, /UnsafeConfiguration/)
    }
    for (const invalid of [
      { CI: 'false' },
      { MIKKA_DATABASE_URL: 'postgresql://postgres@db.invalid/test_176' },
      { MIKKA_DATABASE_URL: 'postgresql://postgres@127.0.0.1/production' },
      { MIKKA_WAKE_CONTROLLED_ORIGIN: 'https://example.invalid' },
      { MIKKA_WAKE_CONTROLLED_ORIGIN: 'http://127.0.0.1:6176/?target=outside' },
    ]) {
      apply({ ...settings, ...invalid })
      assert.throws(controlledWakeConfiguration, /UnsafeConfiguration/)
    }
  } finally {
    apply(previous)
  }
})
