import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cliPolicyLayerSchema } from './policy-store'

test('CLI policy layers accept the four existing CLI actions', () => {
  const permissions = {
    install_dependency: 'allow',
    write_outside_repo: 'deny',
    git_push: 'ask',
    network: 'allow',
  }
  assert.deepEqual(cliPolicyLayerSchema.parse({ permissions }), { permissions })
  assert.deepEqual(cliPolicyLayerSchema.parse({}), {})
  for (const action of ['install_dependency', 'git_push', 'network']) {
    for (const decision of ['allow', 'ask', 'deny']) {
      const layer = { permissions: { [action]: decision } }
      assert.deepEqual(cliPolicyLayerSchema.parse(layer), layer)
    }
  }
  for (const decision of ['ask', 'deny']) {
    const layer = { permissions: { write_outside_repo: decision } }
    assert.deepEqual(cliPolicyLayerSchema.parse(layer), layer)
  }
})

test('CLI policy layers reject computer authority rather than accepting or stripping it', () => {
  for (const decision of ['allow', 'ask', 'deny']) {
    assert.equal(cliPolicyLayerSchema.safeParse({ permissions: { network: 'deny', computer_use: decision } }).success, false)
  }
})

test('CLI policy layers reject unknown actions and layer fields', () => {
  assert.equal(cliPolicyLayerSchema.safeParse({ permissions: { future_action: 'allow' } }).success, false)
  assert.equal(cliPolicyLayerSchema.safeParse({ computer_use: 'allow' }).success, false)
  assert.equal(cliPolicyLayerSchema.safeParse({ future_layer: {} }).success, false)
})
