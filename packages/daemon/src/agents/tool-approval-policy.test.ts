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

it('leaves registered computer actions to the existing broker without duplicating ask', () => {
  const base = defaultRunPolicy()
  const request: ToolApprovalRequest = {runId:'r',requestId:'i',harness:'claude_code',method:'cli/mcp__mikka_computer__click',input:{x:1,y:2}}
  for (const computer_use of ['allow','ask'] as const) expect(toolApprovalDecision(request,{...base,permissions:{...base.permissions,computer_use}},'/worktree')).toBe('allow')
  expect(toolApprovalDecision(request,{...base,permissions:{...base.permissions,computer_use:'deny'}},'/worktree')).toBe('deny')
  expect(toolApprovalDecision(request,{...base,readOnly:true},'/worktree')).toBe('deny')
  expect(toolApprovalDecision({...request,method:'cli/mcp__mikka_computer__arbitrary_tool'},base,'/worktree')).toBe('unavailable')
  expect(toolApprovalDecision({...request,method:'cli/mcp__other__click'},base,'/worktree')).toBe('unavailable')
})

it('preserves the computer ceiling for every capture transport registration', () => {
  for (const name of ['capture_screenshot','start_screen_recording','stop_screen_recording']) {
    const base = defaultRunPolicy()
    const request: ToolApprovalRequest = {runId:'r',requestId:name,harness:'claude_code',method:`cli/mcp__mikka_computer__${name}`,input:{}}
    expect(toolApprovalDecision(request,base,'/worktree')).toBe('allow')
    expect(toolApprovalDecision(request,{...base,readOnly:true},'/worktree')).toBe('deny')
    expect(toolApprovalDecision(request,{...base,permissions:{...base.permissions,computer_use:'deny'}},'/worktree')).toBe('deny')
    expect(toolApprovalDecision(request,{...base,permissions:{...base.permissions,computer_use:undefined}},'/worktree')).toBe('deny')
  }
})


it('permits only registered hand-in transport while context authority stays server-owned', () => {
  const policy = { ...defaultRunPolicy(), readOnly: true }
  const request: ToolApprovalRequest = { runId: 'r', requestId: 'context', harness: 'claude_code', method: 'cli/mcp__mikka__request_help', input: { question: 'Existing task context?' } }
  expect(toolApprovalDecision(request, policy, '/worktree')).toBe('allow')
  expect(toolApprovalDecision({ ...request, method: 'cli/mcp__other__request_help' }, policy, '/worktree')).toBe('unavailable')
  expect(toolApprovalDecision({ ...request, method: 'cli/mcp__mikka__arbitrary_tool' }, policy, '/worktree')).toBe('unavailable')
  expect(toolApprovalDecision(request, undefined, '/worktree')).toBe('unavailable')
})
