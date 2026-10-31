import assert from 'node:assert/strict'
import test from 'node:test'
import { admitGatewayRoute, admitModelRoute, GATEWAY_MODEL_ENDPOINT, managedGatewayOptions, ModelAdmissionError, parseModelAdmissionPolicy, subscriptionModelRoute } from './contract'

const request = { ownerId: 'alice', model: 'deepseek/deepseek-v4.1-flash', endpoint: GATEWAY_MODEL_ENDPOINT }
const rule = { provider: 'vercel-gateway', endpoint: GATEWAY_MODEL_ENDPOINT, model: request.model,
  servingProviders: ['deepseek'], principalIds: ['alice'], dataRegions: ['unknown'] }
const policy = () => parseModelAdmissionPolicy({ schemaVersion: 1, routes: [rule] })
const denied = (code: string) => (error: unknown) => error instanceof ModelAdmissionError && error.code === code

test('managed Gateway admission pins the exact principal, model and server endpoint', () => {
  const admitted = admitGatewayRoute(policy(), request)
  assert.deepEqual(admitted.servingProviders, ['deepseek'])
  assert.equal(admitted.dataRegion, 'unknown')
  assert.deepEqual(managedGatewayOptions(admitted), { only: ['deepseek'], order: ['deepseek'], models: [] })
  for (const changed of [{ model: 'deepseek/auto' }, { model: `${request.model}\n` }, { ownerId: 'bob' },
    { endpoint: 'https://proxy.example/v4/ai' }, { endpoint: `${GATEWAY_MODEL_ENDPOINT}?redirect=https://proxy.example` }])
    assert.throws(() => admitGatewayRoute(policy(), { ...request, ...changed }), denied('modelRouteDenied'))
})
test('revocation, absent principal and unproved regions refuse rather than falling back', () => {
  assert.throws(() => admitGatewayRoute({ ...policy(), revoked: true }, request), denied('modelPolicyRevoked'))
  assert.throws(() => admitGatewayRoute(policy(), { ...request, ownerId: null }), denied('modelPrincipalUnavailable'))
  const regional = parseModelAdmissionPolicy({ schemaVersion: 1, routes: [{ ...rule, dataRegions: ['eu'] }] })
  assert.throws(() => admitGatewayRoute(regional, request), denied('modelRegionUnverified'))
})
test('policy input cannot declare another transport, proxy URL or undocumented fields', () => {
  for (const changed of [{ endpoint: 'https://proxy.example' }, { provider: 'arbitrary' }, { model: 'Auto' },
    { servingProviders: [] }, { servingProviders: ['deepseek','another-provider'] }, { credentials: 'never accepted' }])
    assert.throws(() => parseModelAdmissionPolicy({ schemaVersion: 1, routes: [{ ...rule, ...changed }] }), denied('modelPolicyInvalid'))
  assert.throws(() => parseModelAdmissionPolicy({schemaVersion:1,routes:[rule,rule]}),denied('modelPolicyInvalid'))
})
test('existing subscription routes pin the worker endpoint, physical provider and exact model without claiming a region', () => {
  for (const kind of ['codex_cpa', 'claude_cpa', 'codex_cli', 'claude_code_cli']) {
    const transport = subscriptionModelRoute(kind)
    const route = { ...transport, model: 'provider-model', servingProviders: [kind.startsWith('codex') ? 'openai' : 'anthropic'], principalIds: ['alice'], dataRegions: ['unknown'] }
    const rule = parseModelAdmissionPolicy({ schemaVersion: 1, routes: [route] })
    const request = { ...transport, ownerId: 'alice', model: route.model }
    assert.equal(admitModelRoute(rule, request).dataRegion, 'unknown')
    for (const changed of [{ model: 'other-model' }, { ownerId: 'bob' }, { provider: 'vercel-gateway' }, { endpoint: 'https://proxy.invalid' }])
      assert.throws(() => admitModelRoute(rule, { ...request, ...changed }), denied('modelRouteDenied'))
    assert.throws(() => admitModelRoute(parseModelAdmissionPolicy({ schemaVersion: 1, routes: [{ ...route, dataRegions: ['us'] }] }), request), denied('modelRegionUnverified'))
    assert.throws(() => parseModelAdmissionPolicy({ schemaVersion: 1, routes: [{ ...route, endpoint: `${transport.endpoint}?proxy=true` }] }), denied('modelPolicyInvalid'))
  }
  assert.throws(() => subscriptionModelRoute('openai_siwc'), denied('modelRouteDenied'))
})
