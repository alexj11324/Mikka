import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { before, test } from 'node:test'
import { mock } from 'node:test'

// #1371: an audit receipt is delivered right after its business change commits, by the
// audit-retention due timer, not at the next hourly sweep.
const armed: Array<{ executor: unknown; kind: string }> = []
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('../db/index.ts', { pool: {}, db: {} })
stub('../workspace-db.ts', { workspacePool: {} })
stub('../due-timer.ts', { armDueTimerAfterCommit: (executor: unknown, kind: string) => { armed.push({ executor, kind }) } })
let enqueueWorkspaceAudit: typeof import('./delivery').enqueueWorkspaceAudit
before(async () => { ({ enqueueWorkspaceAudit } = await import('./delivery')) })

test('enqueueing an audit receipt arms the audit-retention timer on the same transaction', async () => {
  const inserted: unknown[] = []
  const tx = { insert: () => ({ values: async (row: unknown) => { inserted.push(row) } }) }
  await enqueueWorkspaceAudit(tx as never, { workspaceId: randomUUID(), actor: { type: 'system' }, action: 'audit.retention_changed', metadata: { retentionDays: 30, legalHold: false } } as never)
  assert.equal(inserted.length, 1)
  assert.deepEqual(armed, [{ executor: tx, kind: 'audit-retention' }])
})
