import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { USER_ERROR_CODES } from '@mikka/protocol/user-error-codes'
import { INTEROP_ERRORS, INTEROP_ERROR_STATUS, InteropError } from './errors'
import { INTEROP_TOOLS, INTEROP_TOOL_IDS, WORKER_RUN_TOOLS } from './tool-schemas'
import { agentDriveOwner, driveScopeProblem, isAgentDriveScope } from '../drive/contract'
import { API_SCOPES, READ_ONLY_API_SCOPES } from '../tokens/format'
import { AGENT_TOOL_IDS, PLATFORM_TOOL_ADDED } from '../agent-kit/registry'

const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e'

test('every interop refusal is a registered user error with copy in both languages', () => {
  const messages = ['en', 'zh-CN'].map(locale => JSON.parse(readFileSync(new URL(`../../messages/${locale}.json`, import.meta.url), 'utf8')).RunErrors)
  for (const [code, details] of Object.entries(INTEROP_ERRORS)) {
    assert.deepEqual(details, USER_ERROR_CODES[code as keyof typeof USER_ERROR_CODES], code)
    assert.ok(INTEROP_ERROR_STATUS[code as keyof typeof INTEROP_ERRORS] >= 400, code)
    for (const copy of messages) {
      assert.equal(typeof copy[code]?.default, 'string', code)
      for (const detail of details) assert.equal(typeof copy[code][detail], 'string', `${code}.${detail}`)
    }
  }
  const error = new InteropError('interop_send_unavailable', { detail: 'bot_unavailable', cause: new Error('inner') })
  assert.deepEqual([error.code, error.detail, error.status, (error.cause as Error).message], ['interop_send_unavailable', 'bot_unavailable', 409, 'inner'])
})

test('tool inputs are strict: ids are uuids, sends need a key, Drive writes need the head they read', () => {
  assert.ok(INTEROP_TOOLS.read_thread_messages.inputSchema.safeParse({ runId: uuid }).success)
  assert.ok(!INTEROP_TOOLS.read_thread_messages.inputSchema.safeParse({ runId: 'run-1' }).success)
  assert.ok(!INTEROP_TOOLS.read_thread_messages.inputSchema.safeParse({ runId: uuid, userId: 'someone-else' }).success, 'no caller-chosen identity')
  assert.ok(!INTEROP_TOOLS.send_to_thread.inputSchema.safeParse({ runId: uuid, text: 'hi' }).success)
  assert.ok(INTEROP_TOOLS.send_to_thread.inputSchema.safeParse({ runId: uuid, text: 'hi', key: 'a-1', delivery: 'steer' }).success)
  assert.ok(!INTEROP_TOOLS.send_to_thread.inputSchema.safeParse({ runId: uuid, text: 'hi', key: 'a-1', delivery: 'interrupt' }).success, 'a peer cannot interrupt')
  assert.ok(!INTEROP_TOOLS.send_to_bot.inputSchema.safeParse({ botId: uuid, text: 'hi', key: 'has space' }).success)
  assert.ok(!INTEROP_TOOLS.drive_write.inputSchema.safeParse({ scope: 'bot', scopeId: uuid, path: 'a.md', content: 'x', mutationId: 'mutation-1' }).success)
  assert.ok(INTEROP_TOOLS.drive_write.inputSchema.safeParse({ scope: 'bot', scopeId: uuid, path: 'a.md', content: 'x', expectedDigest: 'a'.repeat(64), mutationId: 'mutation-1' }).success)
  assert.ok(!INTEROP_TOOLS.drive_list.inputSchema.safeParse({ scope: 'user' }).success, 'a person\'s own Drive is not an interop scope')
  assert.deepEqual(Object.keys(WORKER_RUN_TOOLS), ['list_runs', 'get_run'])
})

test('the interop tools are registered platform tools added after earlier stored versions', () => {
  for (const id of INTEROP_TOOL_IDS) {
    assert.ok((AGENT_TOOL_IDS as readonly string[]).includes(id), id)
    assert.ok(PLATFORM_TOOL_ADDED[id as keyof typeof PLATFORM_TOOL_ADDED], id)
  }
  const definition = JSON.parse(readFileSync(new URL('../../agents/default/agent.json', import.meta.url), 'utf8')) as { tools: string[] }
  for (const id of INTEROP_TOOL_IDS) assert.ok(definition.tools.includes(id), id)
})

test('agent Drive scopes name a uuid and their own storage namespace', () => {
  for (const scope of ['bot', 'thread', 'environment'] as const) {
    assert.ok(isAgentDriveScope(scope))
    assert.equal(driveScopeProblem(scope, uuid, null), null)
    assert.equal(driveScopeProblem(scope, 'not-a-uuid', null), 'scope_id_empty')
    assert.equal(driveScopeProblem(scope, uuid, 'person'), 'scope_user_unexpected')
  }
  assert.ok(!isAgentDriveScope('team-workspace'))
  assert.equal(agentDriveOwner(uuid, 'bot', uuid), `drive-scope:${uuid}:bot:${uuid}`)
})

test('interop PAT scopes are selectable and the read-only set holds no write scope', () => {
  for (const scope of ['threads:read', 'threads:write', 'artifacts:read', 'drive:read', 'drive:write', 'bots:read', 'bots:write', 'grants:read', 'grants:write'])
    assert.ok((API_SCOPES as readonly string[]).includes(scope), scope)
  assert.ok(READ_ONLY_API_SCOPES.every(scope => scope.endsWith(':read')))
})
