import test from 'node:test'
import assert from 'node:assert/strict'
import { PaidResourceError } from '@/lib/abuse/policy'
import { DEFAULT_MACHINE_SIZE, MACHINE_CHUNK_MS, machineChunkMicroUsd, machineHourlyUsd } from './machine-pricing'
import { fundMachineChunk, machineChunkId, type MachineBillingDependencies, type MachineChunk } from './machine-billing'

test('machines are priced by memory at USD 0.025 per GiB-hour; standard-3 is the default', () => {
  assert.deepEqual(['standard-1', 'standard-2', 'standard-3', 'standard-4', 'standard-4-16'].map(size => machineHourlyUsd(size as never)), [0.1, 0.15, 0.2, 0.3, 0.4])
  assert.equal(DEFAULT_MACHINE_SIZE, 'standard-3')
  // A five-minute chunk of standard-3: USD 0.2 / 12.
  assert.equal(MACHINE_CHUNK_MS, 300_000)
  assert.equal(machineChunkMicroUsd('standard-3'), 16_667)
})

const chunk: MachineChunk = { ownerId: 'owner', workspaceId: 'workspace', runId: 'run', operationId: 'op', index: 2, size: 'standard-3' }

function fake(states: Map<string, string>, charge: MachineBillingDependencies['charge']): MachineBillingDependencies & { charged: number[] } {
  const charged: number[] = []
  return { charged, state: async id => states.get(id) ?? null, charge: async (c, id, cost) => { await charge(c, id, cost); charged.push(cost); states.set(id, 'settled') } }
}

test('a chunk is charged once at its prepaid price; a retried renewal never charges twice', async () => {
  const states = new Map<string, string>()
  const deps = fake(states, async () => {})
  assert.equal(await fundMachineChunk(chunk, deps), true)
  assert.equal(await fundMachineChunk(chunk, deps), true)
  assert.deepEqual(deps.charged, [16_667])
  assert.equal(machineChunkId(chunk), 'machine:run:op:2')
})

test('nothing to pay with: unfunded, not an error', async () => {
  for (const code of ['points_exhausted', 'verification_required', 'usage_budget_exhausted'] as const) {
    const deps = fake(new Map(), async () => { throw new PaidResourceError(code) })
    assert.equal(await fundMachineChunk(chunk, deps), false, code)
  }
})

test('a concurrent charge of the same chunk counts only once it settled; other failures keep their cause', async () => {
  const states = new Map<string, string>([[machineChunkId(chunk), 'pending']])
  const busy = fake(states, async () => { throw new PaidResourceError('usage_in_progress') })
  assert.equal(await fundMachineChunk(chunk, busy), false)
  states.set(machineChunkId(chunk), 'settled')
  assert.equal(await fundMachineChunk(chunk, busy), true)
  const broken = fake(new Map(), async () => { throw new TypeError('database down') })
  await assert.rejects(fundMachineChunk(chunk, broken), (error: Error) => error.message === 'machine_chunk_charge_failed' && error.cause instanceof TypeError)
})
