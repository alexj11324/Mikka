import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FIXTURE, fixtureSnapshot, syntheticPrompt, markerEvidence, sdkRequestEvidence, safeLog, probeEnvironment } from './codex-cache-control.mjs'
import { withCodexSystemCacheBreakpoints } from '../../../lib/prompt-cache.ts'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

const row = () => ({ ...FIXTURE, botId: FIXTURE.botId, runOwnerId: FIXTURE.ownerId, ownerId: FIXTURE.credentialOwnerId,
  consumerId: FIXTURE.botId, custodyWorkspaceId: '00000000-0000-4000-8000-000000000003',
  connectionOwnerId: FIXTURE.credentialOwnerId, provider: 'codex', state: 'connected', paused: false, epoch: '2', connectionRevision: '2',
  botArchivedAt: null, connectionRemovedAt: null, apiKeyId: null, shareAllowed: true, activeWork: false })

test('the real marker transform changes only two stable synthetic boundaries', () => {
  const base = syntheticPrompt(), saved = structuredClone(base)
  const marked = withCodexSystemCacheBreakpoints(base, FIXTURE.modelId)
  const proof = markerEvidence(base, marked)
  assert.deepEqual(base, saved)
  assert.equal(proof.stableBoundaryCount, 2)
  assert.equal(proof.toolCount, 0)
  assert.ok(proof.prefixes.every(prefix => prefix.utf8Bytes > 16000 && prefix.numberedRules === 128))
  const changed = structuredClone(marked); changed[2].content[0].text += 'changed'
  assert.throws(() => markerEvidence(base, changed), /payload_difference_invalid/)
})

test('actual SDK request projection rejects any difference beyond the marker', () => {
  const body = { model: FIXTURE.modelId, stream: true, messages: syntheticPrompt().map(message => ({ role: message.role, content: message.content })) }
  const first = sdkRequestEvidence({ body: JSON.stringify(body) }, 0)
  const marked = structuredClone(body)
  for (const message of marked.messages.slice(0, 2)) message.mikka_cache_breakpoint = 'stable_system_v1'
  const second = sdkRequestEvidence({ body: JSON.stringify(marked) }, 2, first)
  assert.equal(second.privateMarkerCount, 2)
  assert.equal(second.noMarkersSha256, first.noMarkersSha256)
  marked.messages[2].content[0].text = 'different'
  assert.throws(() => sdkRequestEvidence({ body: marked }, 2, first), /sdk_payload_difference_invalid/)
})

test('the installed real SDK serializes exactly zero versus two private hints', async () => {
  let previous, transportCalls = 0
  const provider = createOpenAICompatible({ name: 'mikka-subscription', baseURL: 'https://fixture.invalid/v1', apiKey: 'synthetic',
    fetch: async (_url, init) => {
      transportCalls++
      const body = JSON.parse(init.body)
      assert.equal(body.model, FIXTURE.modelId)
      const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 0, model: FIXTURE.modelId,
        choices: [{ index: 0, delta: { content: 'ACK' }, finish_reason: null }] }
      const finish = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } })
    } })
  const base = syntheticPrompt()
  for (const [count, prompt] of [[0, base], [2, withCodexSystemCacheBreakpoints(base, FIXTURE.modelId)]]) {
    const result = await provider(FIXTURE.modelId).doStream({ prompt })
    const evidence = sdkRequestEvidence(result.request, count, previous)
    previous ??= evidence
    for await (const part of result.stream) assert.notEqual(part.type, 'error')
  }
  assert.equal(transportCalls, 2, 'offline SDK encoding only; the fake transport never contacts a provider')
})

test('fixed shared fixture rejects scope, grant, active work and epoch drift', () => {
  const fixed = fixtureSnapshot([row()])
  assert.deepEqual(fixtureSnapshot([row()], fixed), fixed)
  for (const delta of [{ runOwnerId: 'foreign' }, { workspaceId: '00000000-0000-4000-8000-000000000099' },
    { consumerId: '00000000-0000-4000-8000-000000000099' }, { ownerId: FIXTURE.ownerId }, { connectionOwnerId: 'foreign' },
    { modelId: 'gpt-6-sol' }, { route: 'openai_siwc' }, { shareAllowed: false }, { activeWork: true },
    { botArchivedAt: '2026-11-07T00:00:00Z' }, { paused: true }, { epoch: '3' }]) {
    assert.throws(() => fixtureSnapshot([{ ...row(), ...delta }]), /fixture_scope_invalid/)
  }
  assert.throws(() => fixtureSnapshot([row(), row()]), /fixture_missing_or_ambiguous/)
  assert.throws(() => fixtureSnapshot([{ ...row(), custodyWorkspaceId: '00000000-0000-4000-8000-000000000099' }], fixed), /fixture_changed/)
})

test('provider observations retain only closed status/type and never arbitrary content', () => {
  assert.deepEqual(safeLog([JSON.stringify({ msg: 'subscription_worker', detail: 'subscription_upstream_failure codex response 400 invalid_request_error' })]),
    { provider: 'codex', stage: 'response', status: 400, type: 'invalid_request_error' })
  for (const value of ['private-provider-body', JSON.stringify({ msg: 'subscription_worker', detail: 'subscription_upstream_failure codex response 400 fixture_secret' }),
    JSON.stringify({ msg: 'other', detail: 'private-provider-body' })]) assert.equal(safeLog([value]), null)
})

test('the child receives only existing required config; no route or model bypass', () => {
  const env = { DATABASE_URL: 'fixture', MIKKA_DATABASE_URL: 'fixture', NEXT_PUBLIC_POSTHOG_KEY: 'fixture',
    MIKKA_BYOS_INFISICAL_ORIGIN: 'https://app.infisical.com', MIKKA_BYOS_INFISICAL_PROJECT: 'fixture',
    MIKKA_BYOS_INFISICAL_ENVIRONMENT: 'prod', MIKKA_BYOS_INFISICAL_PATH: '/fixture-custody',
    MIKKA_BYOS_ACCESS_INFISICAL_PATH: '/fixture-access', MIKKA_BYOS_INFISICAL_TOKEN: 'fixture-custody-token',
    MIKKA_BYOS_ACCESS_INFISICAL_TOKEN: 'fixture-access-token', MIKKA_BYOS_VALIDATED_MODEL_ROUTES: 'codex_cpa',
    AI_GATEWAY_API_KEY: 'must-not-pass', GITHUB_CLIENT_SECRET: 'must-not-pass', VERCEL_TEAM_TOKEN: 'must-not-pass' }
  const child = probeEnvironment(env)
  assert.equal(child.MIKKA_BYOS_VALIDATED_MODEL_ROUTES, undefined)
  assert.equal(child.AI_GATEWAY_API_KEY, undefined)
  assert.equal(child.GITHUB_CLIENT_SECRET, undefined)
  assert.equal(child.VERCEL_TEAM_TOKEN, undefined)
  assert.throws(() => probeEnvironment({ ...env, MIKKA_BYOS_ACCESS_INFISICAL_TOKEN: env.MIKKA_BYOS_INFISICAL_TOKEN }), /configuration_missing/)
})
