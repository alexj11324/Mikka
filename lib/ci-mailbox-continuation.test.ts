import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PoolClient } from 'pg'
import { DEFAULT_AGENT_DEFINITION } from './agent-kit/builtin'
import { digest, makeSnapshot } from './agent-kit/definition'
import { freezeWorkerDefinition } from './agent-kit/worker'
import { authorizeContinuationMailbox, continuationMailboxParent, currentContinuationMailboxAuthorized } from './ci-mailbox-continuation'

const owner = 'owner', botId = '28700000-0000-4000-8000-000000000011', workspaceId = '28700000-0000-4000-8000-000000000012'
const revisionId = '28700000-0000-4000-8000-000000000013', executionId = '28700000-0000-4000-8000-000000000014'
function setup() {
  const snapshot = makeSnapshot(revisionId, 1, { ...DEFAULT_AGENT_DEFINITION, tools: ['mailbox_inbox'] }, 'HOST', { harness: 'ai_sdk', model: 'synthetic' })
  const state = { owner, key: botId, workspace: workspaceId, active: snapshot.definition, snapshot, version: revisionId, executionId, locked: false, botOwner: owner }
  const client = { async query(sql: string, values: unknown[]) {
    if (sql.startsWith('SELECT id,snapshot,status FROM agent_kit_executions')) return { rows: values[0] === state.owner && values[1] === state.executionId ? [{ id: executionId, snapshot: state.snapshot, status: 'completed' }] : [] }
    if (sql.startsWith('SELECT "workspaceId" FROM bots')) return { rows: values[0] === botId && values[1] === state.botOwner ? [{ workspaceId: state.workspace }] : [] }
    if (sql.startsWith('select bot_key')) return { rows: values[0] === state.owner && values[1] === state.executionId ? [{ bot_key: state.key }] : [] }
    if (sql.startsWith('select active_version')) { state.locked = sql.endsWith('for share'); return { rows: values[0] === state.owner && values[1] === state.key ? [{ active_version: state.version, workspace_id: state.workspace }] : [] } }
    if (sql.startsWith('select snapshot')) return { rows: values[0] === state.owner && values[1] === state.key && values[2] === state.executionId ? [{ snapshot: state.snapshot, status: 'completed', version_id: state.snapshot.revisionId }] : [] }
    if (sql.startsWith('select definition')) return { rows: [{ definition: state.active, digest: digest(state.active) }] }
    throw Error(`Unexpected SQL: ${sql}`)
  } } as unknown as PoolClient
  const source = freezeWorkerDefinition({ harness: 'codex', instructions: 'Agent', prompt: 'Original', parent: snapshot, executionId, mailboxEnabled: true, mailboxScope: { botId, workspaceId } })
  return { client, snapshot, source, state }
}

test('reconstructs the original parent and keeps only the frozen current grant', async () => {
  const f = setup()
  const parent = await continuationMailboxParent(f.client, owner, f.source, true)
  assert.ok(parent)
  const child = freezeWorkerDefinition({ harness: 'codex', instructions: 'Agent', prompt: 'CI result', parent: parent.snapshot, executionId: parent.id, mailboxEnabled: true, mailboxScope: { botId, workspaceId } })
  assert.equal(child.definitionDigest, f.source.definitionDigest)
  await authorizeContinuationMailbox(f.client, owner, botId, workspaceId, f.source, child, true)
  assert.equal(f.state.locked, true)
  assert.equal(await currentContinuationMailboxAuthorized(f.client, owner, botId, f.source, child, true), true)
  f.state.active = { ...f.state.active, tools: ['mailbox_inbox', 'mailbox_send'] }
  await authorizeContinuationMailbox(f.client, owner, botId, workspaceId, f.source, child, true)
  assert.deepEqual(child.mailbox?.tools, ['mailbox_inbox'])
})

test('revoked, moved, tampered or disabled grants never authorize continuation', async () => {
  const f = setup()
  const child = freezeWorkerDefinition({ harness: 'codex', instructions: 'Agent', prompt: 'CI', parent: f.snapshot, executionId, mailboxEnabled: true, mailboxScope: { botId, workspaceId } })
  assert.equal(await currentContinuationMailboxAuthorized(f.client, owner, botId, f.source, child, false), false)
  assert.equal(await currentContinuationMailboxAuthorized(f.client, 'other', botId, f.source, child, true), false)
  f.state.active = { ...f.state.active, tools: [] }
  assert.equal(await currentContinuationMailboxAuthorized(f.client, owner, botId, f.source, child, true), false)
  f.state.active = f.snapshot.definition
  f.state.workspace = '28700000-0000-4000-8000-000000000099'
  assert.equal(await currentContinuationMailboxAuthorized(f.client, owner, botId, f.source, child, true), false)
  f.state.workspace = workspaceId
  const tampered = structuredClone(f.source); tampered.mailbox!.tools.push('mailbox_send')
  await assert.rejects(continuationMailboxParent(f.client, owner, tampered, true))
  await assert.rejects(continuationMailboxParent(f.client, 'other', f.source, true))
})
