import { expect, it } from 'vitest'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { toolApprovalDecision } from './tool-approval-policy'
import type { ToolApprovalRequest } from './tool-approval'

it('permits only the host-enabled fixed mailbox transport without widening other tools', () => {
  const policy = { ...defaultRunPolicy(), readOnly: true }
  for (const name of ['mailbox_recipients', 'mailbox_send', 'mailbox_inbox', 'mailbox_ack', 'mailbox_sent']) {
    const request: ToolApprovalRequest = { runId: 'r', requestId: name, harness: 'claude_code', method: `cli/mcp__mikka_mailbox__${name}`, input: {} }
    expect(toolApprovalDecision(request, policy, '/worktree')).toBe('unavailable')
    expect(toolApprovalDecision(request, policy, '/worktree', [], [], true)).toBe('allow')
  }
  for (const method of ['cli/mcp__mikka_mailbox__arbitrary_tool', 'cli/mcp__other_mailbox__mailbox_send', 'cli/Bash'])
    expect(toolApprovalDecision({ runId: 'r', requestId: method, harness: 'claude_code', method, input: {} }, policy, '/worktree', [], [], true)).toBe('unavailable')
})

it('uses the trusted network setting for host proxy requests without inspecting commands', () => {
  const base = defaultRunPolicy()
  const request: ToolApprovalRequest = {runId:'r',requestId:'i',harness:'codex',method:'sandbox/network',input:{host:'example.invalid',port:443}}
  for (const decision of ['allow','ask','deny'] as const) expect(toolApprovalDecision(request,{...base,permissions:{...base.permissions,network:decision}})).toBe(decision)
  expect(toolApprovalDecision({...request,input:{host:'example.invalid',port:0}},base)).toBe('deny')
  expect(toolApprovalDecision({...request,method:'cli/sandbox/network'},base)).toBe('unavailable')
})

it('pre-authorizes the repo allow list and the run endpoints under ask, and asks for anything else', () => {
  const base = defaultRunPolicy()
  const policy = {...base,networkAllow:['github.com','*.githubusercontent.com'],permissions:{...base.permissions,network:'ask' as const}}
  const to = (host: string, port = 443) => ({runId:'r',requestId:'i',harness:'claude_code' as const,method:'sandbox/network',input:{host,port}})
  expect(toolApprovalDecision(to('github.com'),policy)).toBe('allow')
  expect(toolApprovalDecision(to('raw.githubusercontent.com'),policy)).toBe('allow')
  expect(toolApprovalDecision(to('example.com'),policy)).toBe('ask')
  expect(toolApprovalDecision(to('api.github.com'),policy)).toBe('ask')
  // The run's own Mikka endpoint (e.g. the GitHub token exchange), host and port exact.
  expect(toolApprovalDecision(to('mikka.example'),policy,undefined,[],['mikka.example'])).toBe('allow')
  expect(toolApprovalDecision(to('mikka.example',8443),policy,undefined,[],['mikka.example:443'])).toBe('ask')
  // `deny` stays deny, even for the allow list.
  expect(toolApprovalDecision(to('github.com'),{...policy,permissions:{...policy.permissions,network:'deny'}})).toBe('deny')
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

it('allows only the app entries this daemon registered; the Mikka server owns each call', () => {
  const base = defaultRunPolicy()
  const request: ToolApprovalRequest = { runId: 'r', requestId: 'app', harness: 'claude_code', method: 'cli/mcp__gmail__GMAIL_SEND_EMAIL', input: { to: 'a@example.com' } }
  expect(toolApprovalDecision(request, base, '/worktree', ['gmail', 'notion'])).toBe('allow')
  expect(toolApprovalDecision({ ...request, harness: 'codex' }, { ...base, readOnly: true }, '/worktree', ['gmail'])).toBe('allow')
  expect(toolApprovalDecision(request, base, '/worktree')).toBe('unavailable')
  expect(toolApprovalDecision(request, base, '/worktree', ['notion'])).toBe('unavailable')
  expect(toolApprovalDecision({ ...request, method: 'cli/mcp__gmailx__GMAIL_SEND_EMAIL' }, base, '/worktree', ['gmail'])).toBe('unavailable')
  expect(toolApprovalDecision({ ...request, method: 'cli/mcp__gmail__' }, base, '/worktree', ['gmail'])).toBe('unavailable')
  expect(toolApprovalDecision({ ...request, method: 'mcp__gmail__GMAIL_SEND_EMAIL' }, base, '/worktree', ['gmail'])).toBe('unavailable')
})

it('WebFetch and WebSearch follow the run network permission; unknown tools stay unavailable', () => {
  const base = defaultRunPolicy()
  for (const tool of ['WebFetch', 'WebSearch']) {
    const request: ToolApprovalRequest = { runId: 'r', requestId: tool, harness: 'claude_code', method: `cli/${tool}`, input: { url: 'https://example.com' } }
    for (const network of ['allow', 'ask', 'deny'] as const) expect(toolApprovalDecision(request, { ...base, permissions: { ...base.permissions, network } }, '/worktree')).toBe(network)
  }
  expect(toolApprovalDecision({ runId: 'r', requestId: 'x', harness: 'claude_code', method: 'cli/WebBrowse', input: {} }, base, '/worktree')).toBe('unavailable')
})
