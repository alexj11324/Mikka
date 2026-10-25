import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { SessionMailbox } from '../lib/session-mailbox'

/** Deterministic real-PG lock interleaving around the actual store queries. */
export async function mailboxCompletionLockAcceptance(pool: Pool, workspace: string, fixture: {
  owner: string; issue: string; role: string; device: string; repo: string; mailboxFirst?: boolean;
}) {
  const { owner, issue, role, device, repo } = fixture
  const runId = randomUUID()
  await pool.query(`insert into agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status)
    values ($1,$2,$3,$4,$5,$6,'running')`, [runId,owner,issue,role,device,repo])
  const store = new SessionMailbox(pool, workspace)
  const highMailbox = `${fixture.mailboxFirst ? '00000000-0000-4000-8000' : 'ffffffff-ffff-4fff-bfff'}-${randomUUID().slice(-12)}`
  await pool.query(`insert into session_mailboxes (id,"userId","workspaceId",kind,"sessionKey","latestRunId") values ($1,$2,$3,'run',$4::text,$4::uuid)`, [highMailbox, owner, workspace, runId])
  await pool.query('update agent_runs set "mailboxId"=$1 where id=$2', [highMailbox, runId])
  const actor = await store.run(owner, runId)
  const coordinator = await store.conversation(owner, 'coordinator')
  assert.equal(coordinator.mailboxId < actor.mailboxId, !fixture.mailboxFirst, 'deterministic mailbox ordering')
  let ownerPid = 0, completePid = 0
  let targetLocked!: () => void, coordinatorLocked!: () => void
  const targetBarrier = new Promise<void>(resolve => { targetLocked = resolve })
  const coordinatorBarrier = new Promise<void>(resolve => { coordinatorLocked = resolve })
  const wrapped = (kind: 'owner' | 'complete') => ({
    async connect() {
      const client = await pool.connect()
      const query = client.query.bind(client)
      const pid = (await query('select pg_backend_pid() as pid')).rows[0].pid
      if (kind === 'owner') ownerPid = pid; else completePid = pid
      return {
        release: () => client.release(),
        async query(sql: string, values?: unknown[]) {
          const result = await query(sql, values)
          if (kind === 'owner' && sql.startsWith('select * from session_mailboxes where id=$1') && /for (no key )?update/.test(sql) && values?.[0] === actor.mailboxId) {
            targetLocked(); await coordinatorBarrier
          }
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
  // Observe the actual server-side wait, not an assumed application schedule.
  const deadline = Date.now() + 6000
  let blocked = false
  try {
    while (Date.now() < deadline) {
      if (completePid && (await pool.query('select $1=any(pg_blocking_pids($2)) as blocked', [ownerPid,completePid])).rows[0].blocked) { blocked = true; break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  } finally { coordinatorLocked() }
  const outcomes = await Promise.allSettled([sending, completing])
  assert.ok(blocked, 'completion must reach the real mailbox barrier')
  assert.deepEqual(outcomes.map(result => result.status), ['fulfilled', 'fulfilled'], JSON.stringify(outcomes))
  assert.equal((await pool.query('select count(*) from run_messages where "dedupeKey"=$1', [key])).rows[0].count, '1')
  assert.equal((await pool.query(`select count(*) from run_messages where "senderMailboxId"=$1 and "mailboxId"=$2`, [actor.mailboxId,coordinator.mailboxId])).rows[0].count, '1')
  assert.equal((await pool.query('select status from agent_runs where id=$1', [runId])).rows[0].status, 'succeeded')
}
