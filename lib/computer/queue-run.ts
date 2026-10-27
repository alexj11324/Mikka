import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { runPrompt } from '@/lib/run-prompt'
import { ComputerError } from './store'

/** Issue access is checked by the caller. Queue and Bot binding are committed
 * together so the cloud worker never observes an unbound queued run. */
export async function queueCloudRun(pool: Pool, actor: { userId: string; workspaceId: string }, input: {
  botId: string; issueId: string; agentId: string; deviceRepoId: string; title: string; body: string; note?: string
}) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const target = (await client.query(`SELECT m."deviceId",a.instructions,repo."baseBranch" FROM bots b
      JOIN bot_desktops d ON d."botId"=b.id AND d."ownerId"=b."ownerId" AND d."workspaceId"=b."workspaceId"
      JOIN cloud_machines m ON m."workspaceId"=b."workspaceId" AND m."ownerId"=b."ownerId" AND m.state='running'
      JOIN devices dev ON dev.id=m."deviceId" AND dev."ownerId"=b."ownerId" AND dev.kind='cloud' AND dev.enabled=true
      JOIN agents a ON a.id=$4 AND a."userId"=b."ownerId" AND a."deviceId"=dev.id
      JOIN device_repos repo ON repo.id=$5 AND repo."deviceId"=dev.id AND repo."userId"=b."ownerId"
      WHERE b.id=$1 AND b."ownerId"=$2 AND b."workspaceId"=$3
        AND EXISTS (SELECT 1 FROM byos_bindings s JOIN byos_connections c ON c.id=s."connectionId" AND c."ownerId"=s."ownerId"
          AND c."workspaceId"=s."workspaceId" AND c.state='connected' AND c.epoch=s."connectionRevision"
          WHERE s.id=(SELECT latest.id FROM byos_bindings latest WHERE latest."ownerId"=b."ownerId" AND latest."consumerId"=a.id::text
            AND latest.route=CASE a.harness WHEN 'codex' THEN 'codex_cli' WHEN 'claude_code' THEN 'claude_code_cli' ELSE '' END
            ORDER BY latest."createdAt" DESC,latest.id DESC LIMIT 1) AND s."workspaceId"=b."workspaceId"::text)`,
    [input.botId, actor.userId, actor.workspaceId, input.agentId, input.deviceRepoId])).rows[0]
    if (!target) throw new ComputerError(409, 'Bot computer task is unavailable')
    const runId = randomUUID()
    await client.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,kind,"baseBranch",prompt)
      VALUES ($1,$2,$3,$4,$5,$6,'queued','implement',$7,$8)`, [runId, actor.userId, input.issueId, input.agentId, target.deviceId, input.deviceRepoId, target.baseBranch, runPrompt(input.title, input.body, target.instructions, input.note)])
    await client.query('INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)', [runId, input.botId, actor.workspaceId, actor.userId])
    await client.query('COMMIT')
    return { runId }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
