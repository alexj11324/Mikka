import assert from 'node:assert/strict'
import test from 'node:test'
import { admitModelRoute, modelAdmissionRevision, ModelAdmissionError, parseModelAdmissionPolicy, subscriptionModelRoute } from './contract'

const request = { ownerId: 'alice', provider: 'litellm', model: 'mikka-default', endpoint: 'https://models.example.test/v1' }
const rule = { provider: request.provider, endpoint: request.endpoint, model: request.model,
  servingProviders: ['litellm'], principalIds: ['alice'], dataRegions: ['unknown'] }
const policy = () => parseModelAdmissionPolicy({ schemaVersion: 1, routes: [rule] })
const denied = (code: string) => (error: unknown) => error instanceof ModelAdmissionError && error.code === code

test('LiteLLM admission pins the exact principal, alias and administrator endpoint', () => {
  const admitted = admitModelRoute(policy(), request)
  assert.deepEqual(admitted.servingProviders, ['litellm'])
  assert.equal(admitted.dataRegion, 'unknown')
  for (const changed of [{ model: 'mikka-title' }, { model: `${request.model}\n` }, { ownerId: 'bob' },
    { provider: 'vercel-gateway' }, { endpoint: 'https://other.example/v1' }, { endpoint: `${request.endpoint}?redirect=https://proxy.example` }])
    assert.throws(() => admitModelRoute(policy(), { ...request, ...changed }), denied('modelRouteDenied'))
})
test('revocation, absent principal and unproved regions refuse rather than falling back', () => {
  assert.throws(() => admitModelRoute({ ...policy(), revoked: true }, request), denied('modelPolicyRevoked'))
  assert.throws(() => admitModelRoute(policy(), { ...request, ownerId: null }), denied('modelPrincipalUnavailable'))
  const regional = parseModelAdmissionPolicy({ schemaVersion: 1, routes: [{ ...rule, dataRegions: ['eu'] }] })
  assert.throws(() => admitModelRoute(regional, request), denied('modelRegionUnverified'))
})
test('policy input refuses retired transports, credential-bearing endpoints and undocumented fields', () => {
  for (const changed of [{ endpoint: 'https://key@models.example/v1' }, { endpoint: 'https://models.example/v1?key=secret' },
    { endpoint: 'ftp://models.example/v1' }, { endpoint: 'https://models.example/v1/' }, { model: '\nAuto' },
    { servingProviders: [] }, { servingProviders: ['litellm', 'another-provider'] }, { credentials: 'never accepted' },
    ...['vercel-gateway', 'zerocat', 'cloudflare-workers-ai', 'openai-compatible'].map(provider => ({ provider }))])
    assert.throws(() => parseModelAdmissionPolicy({ schemaVersion: 1, routes: [{ ...rule, ...changed }] }), denied('modelPolicyInvalid'))
  assert.throws(() => parseModelAdmissionPolicy({ schemaVersion: 1, routes: [rule, rule] }), denied('modelPolicyInvalid'))
  assert.equal(admitModelRoute(parseModelAdmissionPolicy({ schemaVersion: 1, routes: [{ ...rule, model: 'vendor/model' }] }), { ...request, model: 'vendor/model' }).model, 'vendor/model')
})
test('existing subscription routes retain their exact worker endpoint, physical provider and model', () => {
  for (const kind of ['codex_cpa', 'claude_cpa', 'codex_cli', 'claude_code_cli']) {
    const transport = subscriptionModelRoute(kind)
    const route = { ...transport, model: 'provider-model', servingProviders: [kind.startsWith('codex') ? 'openai' : 'anthropic'], principalIds: ['alice'], dataRegions: ['unknown'] }
    const rule = parseModelAdmissionPolicy({ schemaVersion: 1, routes: [route] })
    const request = { ...transport, ownerId: 'alice', model: route.model }
    assert.equal(admitModelRoute(rule, request).dataRegion, 'unknown')
    for (const changed of [{ model: 'other-model' }, { ownerId: 'bob' }, { provider: 'litellm' }, { endpoint: 'https://proxy.invalid' }])
      assert.throws(() => admitModelRoute(rule, { ...request, ...changed }), denied('modelRouteDenied'))
    assert.throws(() => admitModelRoute(parseModelAdmissionPolicy({ schemaVersion: 1, routes: [{ ...route, dataRegions: ['us'] }] }), request), denied('modelRegionUnverified'))
    assert.throws(() => parseModelAdmissionPolicy({ schemaVersion: 1, routes: [{ ...route, endpoint: `${transport.endpoint}?proxy=true` }] }), denied('modelPolicyInvalid'))
  }
  assert.throws(() => subscriptionModelRoute('openai_siwc'), denied('modelRouteDenied'))
})

test('policy revisions survive PostgreSQL JSON object key ordering, including retired policies', () => {
  const policy = { schemaVersion: 1, routes: [rule] }
  const reordered = { routes: [{ dataRegions: rule.dataRegions, principalIds: rule.principalIds, servingProviders: rule.servingProviders,
    model: rule.model, endpoint: rule.endpoint, provider: rule.provider }], schemaVersion: 1 }
  assert.equal(modelAdmissionRevision(policy), modelAdmissionRevision(reordered))
  assert.notEqual(modelAdmissionRevision(policy), modelAdmissionRevision({ ...reordered, routes: [] }))
})
