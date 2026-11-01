// Seeds a Factory question through the same host dispatch and hand-in record as
// tests/factory-question-http.test.ts. Run with server-only + tsx against the
// disposable E2E database only; prints the ids as JSON.
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { remoteKey } from '@mikka/protocol/repository'
import { createFactoryStore } from '../../../lib/factory/store'
import { factoryBinding } from '../../../lib/factory/dispatch'
import { createFactoryQuestions } from '../../../lib/factory/questions/store'
import { factoryTestLifecycle } from '../../helpers/factory-test-authority'
import { recordPushGrant } from '../../support/github-app-stub'

const [email, title, prompt, question] = process.argv.slice(2)
const target = new URL(process.env.DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')

const pool = new Pool({ connectionString: target.toString(), max: 1 })
const authorize = async (u: string, i: string, tx: PoolClient) => (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [i, u])).rowCount === 1
const store = createFactoryStore(pool, authorize, null, factoryTestLifecycle)
const questions = createFactoryQuestions(pool, authorize, store, async () => { throw new Error('seed cannot dispatch') })
async function main() {
  try {
    const { dispatchFactoryRun } = await import('../../../lib/factory/server')
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email=$1', [email])
    const { rows: [issue] } = await pool.query<{ id: string }>('SELECT id FROM issues WHERE "userId"=$1 AND title=$2', [user.id, title])
    let { rows: [agent] } = await pool.query<{ id: string; deviceRepoId: string }>(
      'SELECT a.id, r.id AS "deviceRepoId" FROM agents a JOIN device_repos r ON r."deviceId"=a."deviceId" WHERE a."userId"=$1 AND a.name=$2', [user.id, 'Question fixture'])
    if (!agent) {
      const deviceId = randomUUID(), repoId = randomUUID(), agentId = randomUUID()
      const remoteUrl = `https://github.com/mikka-ci/thread-question-${repoId}.git`
      await pool.query(`INSERT INTO devices (id,"ownerId",name,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'Question device',true,now(),'[{"harness":"codex","installed":true}]')`, [deviceId, user.id])
      await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)', [repoId, deviceId, user.id, remoteKey(remoteUrl), remoteUrl])
      await pool.query(`INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,$2,'Question fixture','codex',$3)`, [agentId, user.id, deviceId])
      // Push is what the GitHub App grants (lib/github/push-grant.ts); record that grant as a live check would.
      await recordPushGrant(pool, user.id, remoteKey(remoteUrl))
      agent = { id: agentId, deviceRepoId: repoId }
    }
    const eventId = randomUUID()
    await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId",payload) VALUES ($1,$2,'user_message',$5,$3,$4)`, [eventId, user.id, issue.id, JSON.stringify({ text: prompt }), eventId])
    const routed = await store.route(user.id, { issueId: issue.id, eventId: randomUUID(), sourceEventId: eventId, rationale: 'E2E fixture' })
    const { runId } = await dispatchFactoryRun(user.id, { binding: factoryBinding(routed.task), agentId: agent.id, deviceRepoId: agent.deviceRepoId })
    // Only the stopped hand-in is synthetic, as in the HTTP question probe.
    await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',prompt=$2,report=$3,"sessionId"=$4,"startedAt"=now(),"finishedAt"=now() WHERE id=$1`,
      [runId, prompt, JSON.stringify({ summary: 'Synthetic run hand-in', openQuestions: [question], question: { questionId: randomUUID(), kind: 'decision', question, options: [] } }), `session:${runId}`])
    await pool.query('INSERT INTO run_chunks (id,"runId",seq,chunk) VALUES ($1,$2,1,$3)', [randomUUID(), runId, JSON.stringify({ type: 'text-delta', id: runId, delta: question })])
    const q = await questions.record(user.id, runId)
    process.stdout.write(JSON.stringify({ runId, questionId: q.id }))
  } finally {
    await pool.end()
    const { pool: runtime } = await import('../../../lib/db')
    await runtime.end().catch(() => {})
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
