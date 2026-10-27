import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { runPrompt } from '@/lib/run-prompt'
import { ComputerError } from './store'

/** Issue access is checked by the caller. Queue and Bot binding are committed
 * together so the cloud worker never observes an unbound queued run. */
export async function queueCloudRun(pool: Pool, actor: { userId: string; workspaceId: string }, input: {
  botId: string; issueId: string; agentId: string; deviceRepoId: string; title: string; body: string; note?: string; idempotencyKey?: string
}) {
  if (input.idempotencyKey !== undefined && (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 256)) throw new ComputerError(400, 'Invalid task request')
  const digest = input.idempotencyKey === undefined ? undefined : createHash('sha256').update(JSON.stringify([actor.userId, input.idempotencyKey])).digest('hex')
  const runId = digest ? `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}` : randomUUID()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
    if (digest) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-task:${digest}`])
    const target = (await client.query(`SELECT m."deviceId",a.instructions,repo."baseBranch" FROM bots b
      JOIN bot_desktops d ON d."botId"=b.id AND d."ownerId"=b."ownerId" AND d."workspaceId"=b."workspaceId"
      JOIN cloud_machines m ON m."workspaceId"=b."workspaceId" AND m."ownerId"=b."ownerId" AND m.state='running'
      JOIN devices dev ON dev.id=m."deviceId" AND dev."ownerId"=b."ownerId" AND dev.kind='cloud' AND dev.enabled=true
      JOIN agents a ON a.id=$4 AND a."userId"=b."ownerId" AND a."deviceId"=dev.id
      JOIN device_repos repo ON repo.id=$5 AND repo."deviceId"=dev.id AND repo."userId"=b."ownerId"
      WHERE b.id=$1 AND b."ownerId"=$2 AND b."workspaceId"=$3
        AND NOT EXISTS (SELECT 1 FROM workspace_computer_policies p WHERE p."workspaceId"=b."workspaceId" AND p.permission='deny')
        AND EXISTS (SELECT 1 FROM byos_bindings s JOIN byos_connections c ON c.id=s."connectionId" AND c."ownerId"=s."ownerId"
          AND c."workspaceId"=s."workspaceId" AND c.state='connected' AND c.epoch=s."connectionRevision"
          WHERE s.id=(SELECT latest.id FROM byos_bindings latest WHERE latest."ownerId"=b."ownerId" AND latest."consumerId"=a.id::text
            AND latest.route=CASE a.harness WHEN 'codex' THEN 'codex_cli' WHEN 'claude_code' THEN 'claude_code_cli' ELSE '' END
            ORDER BY latest."createdAt" DESC,latest.id DESC LIMIT 1) AND s."workspaceId"=b."workspaceId"::text)`,
    [input.botId, actor.userId, actor.workspaceId, input.agentId, input.deviceRepoId])).rows[0]
    if (!target) throw new ComputerError(409, 'Bot computer task is unavailable')
    const prompt = runPrompt(input.title, input.body, target.instructions, input.note)
    if (digest) {
      const existing = (await client.query(`SELECT r."userId",r."issueId",r."agentId",r."deviceId",r."deviceRepoId",r.prompt,b."botId",b."workspaceId"
        FROM agent_runs r LEFT JOIN computer_run_bindings b ON b."runId"=r.id WHERE r.id=$1`, [runId])).rows[0]
      if (existing) {
        if (existing.userId !== actor.userId || existing.issueId !== input.issueId || existing.agentId !== input.agentId || existing.deviceId !== target.deviceId || existing.deviceRepoId !== input.deviceRepoId || existing.botId !== input.botId || existing.workspaceId !== actor.workspaceId || existing.prompt !== prompt) throw new ComputerError(409, 'Task request changed')
        await client.query('COMMIT')
        return { runId }
      }
    }
    await client.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,kind,"baseBranch",prompt)
      VALUES ($1,$2,$3,$4,$5,$6,'queued','implement',$7,$8)`, [runId, actor.userId, input.issueId, input.agentId, target.deviceId, input.deviceRepoId, target.baseBranch, prompt])
    await client.query('INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)', [runId, input.botId, actor.workspaceId, actor.userId])
    await client.query('COMMIT')
    return { runId }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
