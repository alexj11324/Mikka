import { expect, it } from 'vitest'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { toolApprovalDecision } from './tool-approval-policy'
import type { ToolApprovalRequest } from './tool-approval'

it('uses the trusted network setting for host proxy requests without inspecting commands', () => {
  const base = defaultRunPolicy()
  const request: ToolApprovalRequest = {runId:'r',requestId:'i',harness:'codex',method:'sandbox/network',input:{host:'example.invalid',port:443}}
  for (const decision of ['allow','ask','deny'] as const) expect(toolApprovalDecision(request,{...base,permissions:{...base.permissions,network:decision}})).toBe(decision)
  expect(toolApprovalDecision({...request,input:{host:'example.invalid',port:0}},base)).toBe('deny')
  expect(toolApprovalDecision({...request,method:'cli/sandbox/network'},base)).toBe('unavailable')
})

it('does not infer action authority from callback text or automatically ask', () => {
  const request: ToolApprovalRequest = { runId:'r', requestId:'i', harness:'codex', method:'item/commandExecution/requestApproval', input:{ command:'npm install example' } }
  const base = defaultRunPolicy()
  for (const decision of ['allow', 'ask', 'deny'] as const) {
    const policy = { ...base, permissions:{ ...base.permissions, install_dependency:decision } }
    expect(toolApprovalDecision(request, policy)).toBe('unavailable')
    expect(toolApprovalDecision({ ...request, input:{ command:'echo unrelated' } }, policy)).toBe('unavailable')
    expect(toolApprovalDecision({ ...request, method:'unknown' }, policy)).toBe('unavailable')
  }
})
