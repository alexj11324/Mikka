import assert from 'node:assert/strict'
import test from 'node:test'
import { gatedFeatures, killSwitches, upcomingFeatures } from '@/lib/feature-flags'
import { desktopFeatures } from './features'

test('desktop flags use only the seven public hook keys and the verified user identity', async () => {
  const calls: [string, string][] = []
  const evaluate = async (key: string, userId: string) => {
    calls.push([key, userId])
    return userId === 'owner' && [gatedFeatures.cloudComputer, upcomingFeatures.product.key, killSwitches.computerTab].includes(key)
  }
  const owner = await desktopFeatures('owner', { evaluate, env: {} })
  assert.equal(owner.cloudComputer, true)
  assert.equal(owner.flags[killSwitches.computerTab], true)
  assert.equal(owner.flags[upcomingFeatures.product.key], true)
  assert.equal(owner.flags[gatedFeatures.computerBilling], false)
  assert.deepEqual(calls.map(([key]) => key).sort(), [...Object.values(upcomingFeatures).map(feature => feature.key), ...Object.values(gatedFeatures), killSwitches.computerTab].sort())
  assert.ok(calls.every(([, userId]) => userId === 'owner'))
  const peer = await desktopFeatures('peer', { evaluate, env: {} })
  assert.equal(peer.cloudComputer, false)
  assert.ok(Object.values(peer.flags).every(value => value === false))
})

test('signed-out config uses public defaults without evaluating an anonymous identity', async () => {
  const features = await desktopFeatures(undefined, { evaluate: async () => { throw new Error('anonymous flag evaluation') }, env: {} })
  assert.equal(features.cloudComputer, false)
  assert.equal(Object.keys(features.flags).length, 7)
  assert.ok(Object.values(features.flags).every(value => value === false))
})

test('the cloud-computer snapshot keeps the exact existing public environment predicates', async () => {
  for (const [deployment, acceptance, enabled, expected] of [
    ['preview', '1', undefined, true], ['production', undefined, '1', true],
    ['preview', undefined, '1', false], ['production', '1', undefined, false],
    [undefined, '1', '1', false], ['production', undefined, 'true', false],
  ] as const) {
    const features = await desktopFeatures(undefined, { env: { NEXT_PUBLIC_COMPUTER_DEPLOYMENT: deployment, NEXT_PUBLIC_COMPUTER_ACCEPTANCE: acceptance, NEXT_PUBLIC_COMPUTER_ENABLED: enabled, PRIVATE_SECRET: 'never returned' } })
    assert.equal(features.cloudComputer, expected)
    assert.equal(JSON.stringify(features).includes('never returned'), false)
  }
  assert.equal((await desktopFeatures(undefined, { env: { NEXT_PUBLIC_COMPUTER_MOCK: '1' } })).cloudComputer, true)
})
