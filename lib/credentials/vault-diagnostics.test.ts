import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InfisicalCredentialVault, type VaultFailure } from './vault'
const ref = '25200000-0000-4000-8000-000000000001'
const base = { origin: 'https://vault.invalid', projectId: 'synthetic', environment: 'prod', secretPath: '/synthetic', accessToken: async () => 'synthetic-token' }
test('diagnostics expose only phase and status, never provider text or credentials', async () => {
  const observations: VaultFailure[] = []
  const vault = new InfisicalCredentialVault({ ...base, fetch: async () => new Response('synthetic-private-body', { status: 403 }), onFailure: f => observations.push(f) })
  await assert.rejects(vault.remove(ref), { code: 'vault_unavailable' })
  assert.deepEqual(observations, [{ stage: 'request', kind: 'http', status: 403 }])
  assert.equal(JSON.stringify(observations).includes('synthetic'), false)
})
test('authentication and transport failures are distinguishable without raw error causes', async () => {
  for (const phase of ['authentication', 'request'] as const) {
    const observations: VaultFailure[] = []
    const vault = new InfisicalCredentialVault({ ...base,
      accessToken: async () => { if (phase === 'authentication') throw new Error('synthetic-private-error'); return 'synthetic-token' },
      fetch: async () => { throw new Error('synthetic-private-transport') }, onFailure: f => observations.push(f),
    })
    await assert.rejects(vault.remove(ref), { code: 'vault_unavailable' })
    assert.deepEqual(observations, [{ stage: phase, kind: 'unavailable' }])
  }
})
test('successful deletion and absent object produce no failure; throwing diagnostic cannot alter fail-closed behavior', async () => {
  for (const status of [200, 404]) {
    const vault = new InfisicalCredentialVault({ ...base, fetch: async () => new Response(null, { status }), onFailure: () => { assert.fail('not a failure') } })
    await vault.remove(ref)
  }
  const vault = new InfisicalCredentialVault({ ...base, fetch: async () => new Response(null, { status: 500 }), onFailure: () => { throw new Error('callback failed') } })
  await assert.rejects(vault.remove(ref), { code: 'vault_unavailable' })
})


test('auth diagnostics preserve numeric denial and discard private response/error details', async () => {
  const { universalAuthTokenProvider } = await import('./universal-auth')
  const observations: unknown[] = []
  const provider = universalAuthTokenProvider({ origin: base.origin, credentials: () => ({ clientId: 'synthetic-id', clientSecret: 'synthetic-secret' }),
    fetch: async () => new Response('synthetic-private-body', { status: 403 }),
    onFailure: failure => { observations.push(failure); throw new Error('diagnostic failed') },
  })
  await assert.rejects(provider.getAccessToken(), { code: 'vault_auth_unavailable' })
  await assert.rejects(provider.getAccessToken(), { code: 'vault_auth_unavailable' })
  assert.deepEqual(observations, [{ kind: 'http', status: 403 }])
})
