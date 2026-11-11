import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DEFAULT_AGENT_DEFINITION } from '@/lib/agent-kit/builtin'
import { digest, makeSnapshot } from '@/lib/agent-kit/definition'
import { lockWritePolicy, type WritePolicyScope } from './write-policy-store'

function fixture(overrides: Partial<WritePolicyScope> = {}) {
 const scope: WritePolicyScope = { ownerId: 'owner', botId: randomUUID(), workspaceId: randomUUID(), runId: randomUUID(), action: 'send_slack_message', ...overrides }
 const key = scope.botId ?? 'coordinator'
 const state = { workspace: scope.workspaceId, headPermissions: {} as unknown, headVersion: '0', workspacePermissions: {} as unknown, workspaceVersion: '0', status: 'running', currentTools: ['send_slack_message'] as typeof DEFAULT_AGENT_DEFINITION.tools, tools: ['send_slack_message'], queries: [] as string[] }
 const revision = randomUUID()
 const definition = { ...DEFAULT_AGENT_DEFINITION, tools: ['send_slack_message'] as typeof DEFAULT_AGENT_DEFINITION.tools }
 const snapshot = makeSnapshot(revision, 1, definition, 'host', { harness:'ai_sdk', model:'openai/gpt-6-luna' })
 const tx = { query: async (sql: string, args: unknown[]) => {
  state.queries.push(sql)
  if (sql.includes('agent_kit_heads')) return { rows: args[0] === scope.ownerId && args[1] === key ? [{ workspace_id: state.workspace, active_version: revision, external_write_permissions: state.headPermissions, external_write_policy_version: state.headVersion }] : [] }
  if (sql.includes('agent_kit_executions')) return { rows: args[0] === scope.ownerId && args[1] === key && args[2] === scope.runId ? [{ status: state.status, version_id: revision, snapshot: { ...snapshot, effectiveTools: state.tools } }] : [] }
  if (sql.includes('agent_kit_versions')) { const current = { ...definition, tools: state.currentTools }; return { rows: [{ definition: current, digest: digest(current) }] } }
  if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
  if (sql.includes('workspace_computer_policies')) return { rows: [{ external_write_permissions: state.workspacePermissions, external_write_policy_version: state.workspaceVersion }] }
  throw Error('unexpected query')
 } } as unknown as Parameters<typeof lockWritePolicy>[0]
 return { scope, state, tx }
}

test('policy is scoped to the host run and locks its head and execution', async () => {
 const f = fixture()
 assert.deepEqual(await lockWritePolicy(f.tx, f.scope), { decision: 'ask', defaulted: true, version: '0' })
 // No setting names the action: the judged fallback applies (R-77).
 assert.deepEqual(await lockWritePolicy(f.tx, f.scope, { fallback: 'allow' }), { decision: 'allow', defaulted: true, version: '0' })
 assert.ok(f.state.queries.filter(sql => !sql.includes('agent_kit_versions') && !sql.includes('pg_advisory_xact_lock')).every(sql => sql.endsWith('for share')))
 f.state.workspacePermissions = { send_slack_message: 'allow' }; f.state.workspaceVersion = '1'
 assert.deepEqual(await lockWritePolicy(f.tx, f.scope), { decision: 'allow', defaulted: false, version: '1' })
 f.state.workspacePermissions = { send_slack_message: 'deny' }; f.state.workspaceVersion = '2'
 assert.deepEqual(await lockWritePolicy(f.tx, f.scope), { decision: 'deny', defaulted: false, version: '2' })
})

test('a Bot head allow, ask or deny never changes the workspace decision or version', async () => {
 const f = fixture()
 f.state.workspacePermissions = { send_slack_message: 'allow' }; f.state.workspaceVersion = '4'
 assert.deepEqual(await lockWritePolicy(f.tx, f.scope), { decision: 'allow', defaulted: false, version: '4' })
 for (const decision of ['deny', 'ask', 'allow']) {
  f.state.headPermissions = { send_slack_message: decision }
  f.state.headVersion = String(Number(f.state.headVersion) + 1)
  assert.deepEqual(await lockWritePolicy(f.tx, f.scope), { decision: 'allow', defaulted: false, version: '4' })
 }
 f.state.workspacePermissions = { send_slack_message: 'deny' }; f.state.workspaceVersion = '5'
 f.state.headPermissions = { send_slack_message: 'allow' }
 assert.deepEqual(await lockWritePolicy(f.tx, f.scope), { decision: 'deny', defaulted: false, version: '5' })
 // A malformed head is not even parsed: only the workspace layer is read.
 f.state.headPermissions = { send_slack_message: 'yes' }
 assert.deepEqual(await lockWritePolicy(f.tx, f.scope), { decision: 'deny', defaulted: false, version: '5' })
})

test('a run that names no workspace keeps only the legacy owner ceiling', async () => {
 const f = fixture({ botId: null, workspaceId: null })
 f.state.headPermissions = { send_slack_message: 'deny' }; f.state.headVersion = '3'
 assert.deepEqual(await lockWritePolicy(f.tx, f.scope), { decision: 'deny', defaulted: false, version: '3' })
 f.state.headPermissions = {}
 assert.deepEqual(await lockWritePolicy(f.tx, f.scope), { decision: 'ask', defaulted: true, version: '3' })
 f.state.headPermissions = { send_slack_message: 'yes' }
 await assert.rejects(lockWritePolicy(f.tx, f.scope), /writePolicyUnavailable/)
})

test('foreign scope, inactive run, revoked tool and corrupt workspace policy fail closed', async () => {
 const f = fixture()
 await assert.rejects(lockWritePolicy(f.tx, { ...f.scope, ownerId: 'other' }), /writePolicyUnavailable/)
 await assert.rejects(lockWritePolicy(f.tx, { ...f.scope, runId: randomUUID() }), /writeRunUnavailable/)
 f.state.workspace = randomUUID(); await assert.rejects(lockWritePolicy(f.tx, f.scope), /writePolicyUnavailable/); f.state.workspace = f.scope.workspaceId
 f.state.status = 'completed'; await assert.rejects(lockWritePolicy(f.tx, f.scope), /writeRunUnavailable/); f.state.status = 'running'
 f.state.tools = []; await assert.rejects(lockWritePolicy(f.tx, f.scope), /writeRunUnavailable/); f.state.tools = ['send_slack_message']
 f.state.currentTools = []; await assert.rejects(lockWritePolicy(f.tx, f.scope), /writeRunUnavailable/); f.state.currentTools = ['send_slack_message']
 f.state.workspacePermissions = { send_slack_message: 'yes' }; await assert.rejects(lockWritePolicy(f.tx, f.scope), /writePolicyUnavailable/)
})
