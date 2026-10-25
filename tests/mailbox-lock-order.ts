import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { SessionMailbox } from '../lib/session-mailbox'

/** Deterministic real-PG lock interleaving around the actual store queries. */
export async function mailboxCompletionLockAcceptance(pool: Pool, workspace: string, fixture: {
  owner: string; issue: string; role: string; device: string; repo: string;
}) {
  const { owner, issue, role, device, repo } = fixture
  const runId = randomUUID()
  await pool.query(`insert into agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status)
    values ($1,$2,$3,$4,$5,$6,'running')`, [runId,owner,issue,role,device,repo])
  const store = new SessionMailbox(pool, workspace)
  const actor = await store.run(owner, runId)
  const coordinator = await store.conversation(owner, 'coordinator')
  let targetLocked!: () => void, coordinatorLocked!: () => void
  const targetBarrier = new Promise<void>(resolve => { targetLocked = resolve })
  const coordinatorBarrier = new Promise<void>(resolve => { coordinatorLocked = resolve })
  const wrapped = (kind: 'owner' | 'complete') => ({
    async connect() {
      const client = await pool.connect()
      const query = client.query.bind(client)
      return {
        release: () => client.release(),
        async query(sql: string, values?: unknown[]) {
          const result = await query(sql, values)
          if (kind === 'owner' && sql.startsWith('select * from session_mailboxes where id=$1') && /for (no key )?update/.test(sql) && values?.[0] === actor.mailboxId) {
            targetLocked(); await coordinatorBarrier
          }
          if (kind === 'complete' && sql.startsWith('insert into session_mailboxes')) coordinatorLocked()
          return result
        },
      }
    },
  }) as unknown as Pool
  const ownerStore = new SessionMailbox(wrapped('owner'), workspace)
  const completionStore = new SessionMailbox(wrapped('complete'), workspace)
  const key = randomUUID()
  const sending = ownerStore.ownerSend(owner, { to: actor.mailboxId, key, text: 'Owner instruction racing result', resume: false })
  const completing = (async () => {
    await targetBarrier
    try { return await completionStore.complete(owner, runId, 'succeeded', 'submitted', { summary: 'Controlled completion' }) }
    finally { coordinatorLocked() }
  })()
  const outcomes = await Promise.allSettled([sending, completing])
  assert.deepEqual(outcomes.map(result => result.status), ['fulfilled', 'fulfilled'], JSON.stringify(outcomes))
  assert.equal((await pool.query('select count(*) from run_messages where "dedupeKey"=$1', [key])).rows[0].count, '1')
  assert.equal((await pool.query(`select count(*) from run_messages where "senderMailboxId"=$1 and "mailboxId"=$2`, [actor.mailboxId,coordinator.mailboxId])).rows[0].count, '1')
  assert.equal((await pool.query('select status from agent_runs where id=$1', [runId])).rows[0].status, 'succeeded')
}
