// Decision 2026-11-05-0330: a person reads the code's words; the raw error is only under 详情.
import assert from 'node:assert/strict'
import test from 'node:test'
import { runErrorLine } from '../lib/run-error.ts'
import messages from '../../../messages/zh-CN.json' with { type: 'json' }

test('a registered code reads as its words, by detail when it has one', () => {
  assert.equal(runErrorLine('run_network_error').line, messages.RunErrors.run_network_error.default)
  assert.equal(runErrorLine('installer_failed (timeout)').line, messages.RunErrors.installer_failed.timeout)
  assert.equal(runErrorLine('installer_failed (unknown_detail)').line, messages.RunErrors.installer_failed.default)
})

test('anything else reads as the generic line; the raw text is kept only for 详情', () => {
  // The sandbox's network is not the model provider's: an unregistered code never borrows another's words.
  const shown = runErrorLine('agent_exited: codex exited with code 1 (E_SANDBOX_NETWORK)')
  assert.equal(shown.line, messages.RunErrors.run_failed.default)
  assert.equal(shown.raw, 'agent_exited: codex exited with code 1 (E_SANDBOX_NETWORK)')
})
