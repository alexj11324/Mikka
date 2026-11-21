import assert from 'node:assert/strict'
import test from 'node:test'

test('a named computer runs the named or the only fitting Agent, never a default one', async () => {
  const { chooseDeviceAgent } = await import('./dispatch-target')
  const agents = [{ id: 'claude-agent', harness: 'claude_code' }, { id: 'codex-agent', harness: 'codex' }]
  const both = new Set(['claude_code', 'codex'])
  assert.deepEqual(chooseDeviceAgent(agents, both, 'codex-agent'), { id: 'codex-agent' })
  assert.deepEqual(chooseDeviceAgent(agents, both, undefined, 'codex'), { id: 'codex-agent' })
  assert.deepEqual(chooseDeviceAgent(agents, both), { error: 'agentRequired' }, 'several Agents and nothing naming one')
  assert.deepEqual(chooseDeviceAgent(agents, both, 'codex-agent', 'claude_code'), { error: 'agentHarnessMissing' })
  assert.deepEqual(chooseDeviceAgent(agents, new Set(['claude_code']), 'codex-agent'), { error: 'agentHarnessMissing' })
  assert.deepEqual(chooseDeviceAgent(agents, new Set(['codex'])), { id: 'codex-agent' }, 'the only installed Agent')
  assert.deepEqual(chooseDeviceAgent(agents, both, undefined, 'cursor'), { error: 'agentHarnessMissing' })
})
