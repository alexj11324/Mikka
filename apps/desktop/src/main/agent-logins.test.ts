import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentSearchPath, parseClaudeStatus, parseCodexStatus } from './agent-logins'

const probe = (stdout: string, extra: Partial<{ missing: boolean; stderr: string }> = {}) => ({ missing: false, stderr: '', ...extra, stdout })

test('Claude Code: subscription with its plan, API key, signed out, missing, unreadable', () => {
  assert.deepEqual(parseClaudeStatus(probe('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}')), { login: 'subscription', plan: 'max' })
  assert.deepEqual(parseClaudeStatus(probe('{"loggedIn":true,"authMethod":"oauth_token"}')), { login: 'subscription', plan: null })
  assert.deepEqual(parseClaudeStatus(probe('{"loggedIn":true,"authMethod":"api_key"}')), { login: 'api-key', plan: null })
  assert.deepEqual(parseClaudeStatus(probe('{"loggedIn":false}')), { login: 'signed-out', plan: null })
  assert.deepEqual(parseClaudeStatus(probe('', { missing: true })), { login: 'missing', plan: null })
  assert.deepEqual(parseClaudeStatus(probe('not json')), { login: 'unknown', plan: null })
  // A plan name that is not a short label never reaches the renderer.
  assert.deepEqual(parseClaudeStatus(probe('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"<script>"}')), { login: 'subscription', plan: null })
})

test('Codex: ChatGPT login, API key, signed out, missing', () => {
  assert.deepEqual(parseCodexStatus(probe('Logged in using ChatGPT')), { login: 'subscription', plan: null })
  assert.deepEqual(parseCodexStatus(probe('', { stderr: 'Logged in using an API key - sk-***' })), { login: 'api-key', plan: null })
  assert.deepEqual(parseCodexStatus(probe('Not logged in')), { login: 'signed-out', plan: null })
  assert.deepEqual(parseCodexStatus(probe('', { missing: true })), { login: 'missing', plan: null })
})

test('the search path adds the usual install folders once', () => {
  const path = agentSearchPath('/usr/bin:/usr/local/bin', 'darwin', '/Users/a')
  assert.deepEqual(path.split(':'), ['/usr/bin', '/usr/local/bin', '/Users/a/.local/bin', '/Users/a/.claude/local', '/opt/homebrew/bin'])
  assert.equal(agentSearchPath('C:\\bin', 'win32', 'C:\\Users\\a'), 'C:\\bin')
})
