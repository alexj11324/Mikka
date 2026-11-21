import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hostedCallId, decodeHostedCallId } from './hosted-call-id.mjs'

const usageId = '00000000-0000-4000-8000-000000000001'
const step = { workflowRunId: 'wrun_native', stepId: 'step_model', attempt: 2 }

test('the persisted proxy tag decodes the actual reservation and exact native step, with a separate non-Workflow form', () => {
  assert.equal(hostedCallId(usageId, step), 'mikka-hosted:' + usageId + ':wrun_native:step_model:2')
  assert.deepEqual(decodeHostedCallId(hostedCallId(usageId, step)), { usageId, ...step })
  assert.deepEqual(decodeHostedCallId(hostedCallId(usageId)), { usageId })
})

test('partial, noncanonical, oversized and foreign IDs cannot become a native billing correlation', () => {
  const native = hostedCallId(usageId, step)
  for (const value of [undefined, null, '', usageId, 'provider-completion', native + ':extra', native + '\n',
    native.replace(':2', ':02'), native.replace(':2', ':-1'), native.replace(':2', ':1000001'),
    native.replace(':wrun_native', ':arbitrary'), native.replace(':step_model', ':arbitrary'),
    'mikka-hosted:' + usageId + ':wrun_' + 'a'.repeat(123) + ':step_' + 'b'.repeat(123) + ':2',
    'mikka-hosted:' + usageId + ':wrun_native:step_model', 'mikka-hosted:' + usageId + ':',
  ]) assert.equal(decodeHostedCallId(value), null)
  for (const value of [{ workflowRunId: step.workflowRunId }, { ...step, attempt: null }, { ...step, attempt: 1.5 }])
    assert.throws(() => hostedCallId(usageId, value), /hosted_call_identity_invalid/)
})
