import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runPrompt } from './run-prompt'
import { runInstructions } from '../packages/daemon/src/agents/run-context'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'

test('a queued GitHub task does not contradict the authenticated agent delivery rules', () => {
  const brief = runPrompt('Update README', 'Append the requested line and open a PR.', '')
  const policy = defaultRunPolicy(); policy.permissions.git_push = 'allow'
  const instructions = runInstructions('/repository', policy, { repository: 'owner/repo', branch: 'task', issueId: 'task', endpoint: 'https://example.com/api/runs/github-token', runToken: 'synthetic' })
  assert.match(instructions, /You own delivery/)
  assert.match(brief, /Follow the delivery rules supplied for this run/)
  assert.doesNotMatch(brief, /handles commits and pushes|do not need to run git commit/)
  policy.readOnly = true
  assert.match(runInstructions('/repository', policy), /Do not commit, push or switch branches/)
})
