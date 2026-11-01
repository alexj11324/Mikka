import test from 'node:test'
import assert from 'node:assert/strict'
import { runInfoParts, type RunInfo } from './run-info-view'

const paidBy = (owner: string, plan: string) => `${owner} 的 ${plan}`
const info = (value: Partial<RunInfo>): RunInfo => ({ machine: null, harness: null, model: null, payer: null, movedTo: null, ...value })

test('运行信息: machine · model · who pays, in that order', () => {
  assert.deepEqual(runInfoParts(info({ machine: { kind: 'device', name: 'my-server' }, harness: 'claude_code', model: 'claude-sonnet', payer: { provider: 'claude', plan: 'Max', ownerName: 'Alex' } }), paidBy),
    ['my-server', 'claude-sonnet', 'Alex 的 Claude Max'])
})

test('the cloud reads E2B; with no model frozen, the Agent stands in', () => {
  assert.deepEqual(runInfoParts(info({ machine: { kind: 'cloud' }, harness: 'codex' }), paidBy), ['E2B', 'Codex'])
})

test('nothing frozen, nothing shown; a payer without a plan or owner keeps what it has', () => {
  assert.deepEqual(runInfoParts(info({}), paidBy), [])
  assert.deepEqual(runInfoParts(info({ payer: { provider: 'codex', plan: null, ownerName: null } }), paidBy), ['ChatGPT'])
})
