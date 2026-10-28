import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DEFAULT_AGENT_DEFINITION } from '@/lib/agent-kit/builtin'
import { digest, makeSnapshot } from '@/lib/agent-kit/definition'
import { lockWritePolicy, type WritePolicyScope } from './write-policy-store'

function fixture() {
 const scope: WritePolicyScope = { ownerId: 'owner', botId: randomUUID(), workspaceId: randomUUID(), runId: randomUUID(), action: 'send_slack_message' }
 const state = { workspace: scope.workspaceId, permissions: {} as unknown, version: '0', workspacePermissions: {} as unknown, workspaceVersion: '0', status: 'running', currentTools: ['send_slack_message'] as typeof DEFAULT_AGENT_DEFINITION.tools, tools: ['send_slack_message'], queries: [] as string[] }
 const revision = randomUUID()
 const definition = { ...DEFAULT_AGENT_DEFINITION, tools: ['send_slack_message'] as typeof DEFAULT_AGENT_DEFINITION.tools }
 const snapshot = makeSnapshot(revision, 1, definition, 'host', { harness:'ai_sdk', model:'openai/gpt-6-luna' })
 const tx = { query: async (sql: string, args: unknown[]) => {
  state.queries.push(sql)
  if (sql.includes('agent_kit_heads')) return { rows: args[0] === scope.ownerId && args[1] === scope.botId ? [{ workspace_id: state.workspace, active_version: revision, external_write_permissions: state.permissions, external_write_policy_version: state.version }] : [] }
  if (sql.includes('agent_kit_executions')) return { rows: args[0] === scope.ownerId && args[1] === scope.botId && args[2] === scope.runId ? [{ status: state.status, version_id: revision, snapshot: { ...snapshot, effectiveTools: state.tools } }] : [] }
  if (sql.includes('agent_kit_versions')) { const current = { ...definition, tools: state.currentTools }; return { rows: [{ definition: current, digest: digest(current) }] } }
  if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
  if (sql.includes('workspace_computer_policies')) return { rows: [{ external_write_permissions: state.workspacePermissions, external_write_policy_version:state.workspaceVersion }] }
  throw Error('unexpected query')
 } } as unknown as Parameters<typeof lockWritePolicy>[0]
 return { scope, state, tx }
}

test('policy is scoped to the host run and locks its head and execution', async () => {
 const f = fixture()
 assert.deepEqual(await lockWritePolicy(f.tx, f.scope), { decision: 'ask', version: '0:0' })
 assert.ok(f.state.queries.filter(sql => !sql.includes('agent_kit_versions') && !sql.includes('pg_advisory_xact_lock')).every(sql => sql.endsWith('for share')))
 f.state.permissions = { send_slack_message: 'allow' }; f.state.version = '1'
 assert.deepEqual(await lockWritePolicy(f.tx, f.scope), { decision: 'allow', version: '1:0' })
 f.state.workspacePermissions = { send_slack_message:'deny' }; f.state.workspaceVersion='1'
 assert.deepEqual(await lockWritePolicy(f.tx,f.scope), {decision:'deny',version:'1:1'})
 f.state.workspacePermissions = {}; f.state.workspaceVersion='0'
 f.state.permissions = { send_slack_message: 'deny' }; f.state.version = '2'
 assert.deepEqual(await lockWritePolicy(f.tx, f.scope), { decision: 'deny', version: '2:0' })
})
test('foreign scope, inactive run, revoked tool and corrupt policy fail closed', async () => {
 const f = fixture()
 await assert.rejects(lockWritePolicy(f.tx, { ...f.scope, ownerId: 'other' }), /writePolicyUnavailable/)
 await assert.rejects(lockWritePolicy(f.tx, { ...f.scope, runId: randomUUID() }), /writeRunUnavailable/)
 f.state.workspace = randomUUID(); await assert.rejects(lockWritePolicy(f.tx, f.scope), /writePolicyUnavailable/); f.state.workspace = f.scope.workspaceId
 f.state.status = 'completed'; await assert.rejects(lockWritePolicy(f.tx, f.scope), /writeRunUnavailable/); f.state.status = 'running'
 f.state.tools = []; await assert.rejects(lockWritePolicy(f.tx, f.scope), /writeRunUnavailable/); f.state.tools = ['send_slack_message']
 f.state.currentTools = []; await assert.rejects(lockWritePolicy(f.tx, f.scope), /writeRunUnavailable/); f.state.currentTools = ['send_slack_message']
 f.state.permissions = { send_slack_message: 'yes' }; await assert.rejects(lockWritePolicy(f.tx, f.scope), /writePolicyUnavailable/)
})
