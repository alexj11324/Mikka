import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { enterprisePrincipal, type EnterprisePrincipal } from '../enterprise/principal'
import { tokenWorkspace } from '../tokens/principal'

const workspaceId = '10000000-0000-4000-8000-000000000001'
const id = '10000000-0000-4000-8000-000000000002'
const denied = new Error('synthetic canonical membership refusal')
const admissions: unknown[] = []
const reject = async (reader: unknown) => { admissions.push(reader); throw denied }
mock.module('../task-workspace', { namedExports: {
  withTaskWorkspace: reject, requireTaskWorkspace: reject, activeTaskWorkspaces: reject,
  taskReaderScope: (reader: string | { id: string }) => ({ userId: typeof reader === 'string' ? reader : reader.id }),
} })
const fail = () => { throw new Error('fact storage must not be reached before canonical admission') }
const botRead = { from() { return botRead }, where() { return botRead }, limit: async () => [{ workspaceId }] }
mock.module('../db', { namedExports: { db: { select: () => botRead, execute: fail, insert: fail, update: fail, transaction: fail } } })
mock.module('../workspace-db', { namedExports: { workspaceDb: { select: fail } } })
mock.module('../issue-access', { namedExports: { issueForUser: fail } })
mock.module('./store', { namedExports: { memoryEnabled: async () => true } })

test('memory preserves the original session, PAT and delegation principal at canonical workspace admission', async () => {
  const memory = await import('./memory')
  const principals: EnterprisePrincipal[] = [
    { kind: 'session', sessionId: 'synthetic-session' },
    { kind: 'pat', tokenId: 'synthetic-pat', workspaceId },
    { kind: 'delegation', workspaceId, credentialId: 'synthetic-delegation', credentialKind: 'run' },
  ]
  for (const principal of principals) {
    const reader = Object.defineProperties({ id: 'synthetic-owner' }, {
      [enterprisePrincipal]: { value: principal },
      [tokenWorkspace]: { value: principal.kind === 'session' ? undefined : workspaceId },
    })
    const operations = [
      () => memory.readMemoryView(reader, workspaceId),
      () => memory.addMemoryFact(reader, workspaceId, { requestId: id, kind: 'preference', subject: 'Synthetic', scope: { kind: 'global', ids: [] } }),
      () => memory.removeMemoryFact(reader, workspaceId, id),
      () => memory.undoMemoryFact(reader, workspaceId, id),
      () => memory.reviewMemoryFact(reader, workspaceId, id, 'approve'),
      () => memory.reviewMemoryFact(reader, workspaceId, id, 'reject'),
      () => memory.setMemoryFactScope(reader, workspaceId, id, { kind: 'global', ids: [] }),
      () => memory.mayCorrectMemoryFact(reader, workspaceId, id, 'Corrected'),
      () => memory.recordMemoryFactUsage(reader, workspaceId, { eventId: id, kind: 'thread', targetId: id }, [id]),
      () => memory.memoryForBotPrompt(reader, id, true),
    ]
    for (const operation of operations) {
      admissions.length = 0
      await assert.rejects(operation, error => error === denied)
      assert.deepEqual(admissions, [reader])
      assert.equal(admissions[0], reader, 'non-enumerable provenance must survive unchanged')
    }
  }
})
