import { expect, it } from 'vitest'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { toolApprovalDecision } from './tool-approval-policy'
import type { ToolApprovalRequest } from './tool-approval'
const request = (command: string): ToolApprovalRequest => ({ runId:'r', requestId:'i', harness:'codex', method:'item/commandExecution/requestApproval', input:{ command } })
it('uses trusted allow and deny only for recognized commands and asks on ambiguity', () => {
  const base = defaultRunPolicy()
  expect(toolApprovalDecision(request('npm install example'), base)).toBe('ask')
  expect(toolApprovalDecision(request('npm install example'), { ...base, permissions:{ ...base.permissions, install_dependency:'allow' } })).toBe('allow')
  expect(toolApprovalDecision(request('npm install'), { ...base, permissions:{ ...base.permissions, install_dependency:'allow' } })).toBe('allow')
  expect(toolApprovalDecision(request('npm install example && echo unsafe'), { ...base, permissions:{ ...base.permissions, install_dependency:'allow' } })).toBe('ask')
  expect(toolApprovalDecision(request('npm install example'), { ...base, permissions:{ ...base.permissions, install_dependency:'deny' } })).toBe('deny')
  expect(toolApprovalDecision(request('echo unknown'), base)).toBe('ask')
  expect(toolApprovalDecision(request('echo unknown'), { ...base, readOnly: true })).toBe('deny')
})
