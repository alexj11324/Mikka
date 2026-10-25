import { lockFactoryRun } from '../factory/run-fence'
import { FactoryError } from '../factory/contract'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { RUN_LEASE_MS } from '@mikka/protocol/device'
import { skillAssignmentReceiptSchema } from '@mikka/protocol/skill'
import { BASELINE_ARTIFACT, BASELINE_MARKDOWN, BASELINE_SKILL } from './builtin-skill'
import { digest, ImprovementError } from './contract'

type Authorize = (userId: string, issueId: string, tx: PoolClient) => Promise<boolean>
export function createSkillAssignments(pool: Pool, authorize: Authorize) {
  async function transaction<T>(work: (tx: PoolClient) => Promise<T>) {
    const tx = await pool.connect()
    try { await tx.query('BEGIN'); const result = await work(tx); await tx.query('COMMIT'); return result }
    catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
  }
  async function owned(tx: PoolClient, userId: string, runId: string, lockRun=false, executionFence=true) {
    if (!z.uuid().safeParse(runId).success) throw new ImprovementError('notFound')
    try { if (executionFence) await lockFactoryRun(tx, userId, runId) }
    catch (error) { if (error instanceof FactoryError) throw new ImprovementError('runUnavailable'); throw error }
    const { rows: [source] } = await tx.query('SELECT "issueId" FROM agent_runs WHERE id=$1 AND "userId"=$2', [runId, userId])
    if (!source?.issueId) throw new ImprovementError('notFound')
    await tx.query('SELECT id FROM issues WHERE id=$1 FOR SHARE', [source.issueId])
    if (!await authorize(userId, source.issueId, tx)) throw new ImprovementError('notFound')
    const { rows: [run] } = await tx.query(`SELECT r.* FROM agent_runs r
      JOIN agents a ON a.id=r."agentId" AND a."userId"=$2 AND a."deviceId"=r."deviceId"
      JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=$2 AND repo."deviceId"=r."deviceId"
      JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=$2 AND d.enabled=true
      WHERE r.id=$1 AND r."userId"=$2 ${lockRun?'FOR UPDATE OF r FOR SHARE OF a,repo,d':'FOR SHARE OF r,a,repo,d'}`, [runId, userId])
    if (!run?.issueId || run.issueId !== source.issueId) throw new ImprovementError('notFound')
    if (run.stopRequestedAt || run.status === 'cancelled') throw new ImprovementError('runUnavailable')
    return run
  }
  async function version(tx: PoolClient) {
    await tx.query('INSERT INTO improvement_skill_versions(id,artifact,markdown) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [BASELINE_ARTIFACT.versionId, JSON.stringify(BASELINE_ARTIFACT), BASELINE_MARKDOWN])
    const { rows: [row] } = await tx.query('SELECT * FROM improvement_skill_versions WHERE id=$1', [BASELINE_ARTIFACT.versionId])
    if (!row || digest(row.artifact) !== digest(BASELINE_ARTIFACT) || row.markdown !== BASELINE_MARKDOWN)
      throw new ImprovementError('configurationDrift')
  }
  async function selectBaseline(userId: string, runId: string, existingTransaction?: PoolClient) {
    const work = async (tx:PoolClient) => {
      // Selection is source preparation, not permission to execute an unadopted retry.
      const run = await owned(tx, userId, runId, false, false)
      const { rows:[prior] } = await tx.query('SELECT * FROM improvement_skill_selections WHERE "runId"=$1',[runId])
      if (!prior && (run.status !== 'queued' || run.startedAt)) throw new ImprovementError('runUnavailable')
      await version(tx)
      await tx.query(`INSERT INTO improvement_skill_selections("runId","userId","issueId","agentId","repoId","deviceId","versionId")
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [run.id, userId, run.issueId, run.agentId, run.deviceRepoId, run.deviceId, BASELINE_ARTIFACT.versionId])
      const { rows: [selection] } = await tx.query('SELECT * FROM improvement_skill_selections WHERE "runId"=$1', [runId])
      if (selection.userId !== userId || selection.issueId !== run.issueId || selection.agentId !== run.agentId ||
        selection.repoId !== run.deviceRepoId || selection.deviceId !== run.deviceId || selection.versionId !== BASELINE_ARTIFACT.versionId)
        throw new ImprovementError('conflict')
      return { runId, artifact: BASELINE_ARTIFACT, status: 'selection_persisted' as const }
    }
    return existingTransaction ? work(existingTransaction) : transaction(work)
  }
  async function preflight(userId: string, runId: string, supportsArtifacts: boolean) {
    const { rows: [selection] } = await pool.query('SELECT "userId" FROM improvement_skill_selections WHERE "runId"=$1', [runId])
    if (!selection) {
      const { rows:[ancestor] }=await pool.query(`WITH RECURSIVE lineage AS (
        SELECT id,"retryOf","userId",0 AS depth FROM agent_runs WHERE id=$1 AND "userId"=$2
        UNION ALL SELECT r.id,r."retryOf",r."userId",l.depth+1 FROM agent_runs r JOIN lineage l ON r.id=l."retryOf" WHERE r."userId"=$2 AND l.depth<10
      ) SELECT 1 FROM lineage l JOIN improvement_skill_selections s ON s."runId"=l.id AND s."userId"=$2 LIMIT 1`,[runId,userId])
      if (ancestor) throw new ImprovementError('sourceRequired')
      return
    }
    if (selection.userId !== userId) throw new ImprovementError('notFound')
    if (!supportsArtifacts) throw new ImprovementError('workerCapabilityRequired')
    await transaction(async tx => { await owned(tx, userId, runId); await version(tx) })
  }
  // Called after the actual claim CAS, before returning that assignment. A
  // receipt proves the server prepared assignment bytes, never delivery/use.
  async function recordClaim(userId: string, deviceId: string, runId: string, leaseExpiresAt: string, supportsArtifacts: boolean) {
    await preflight(userId,runId,supportsArtifacts)
    return transaction(async tx => {
      const { rows: [selection] } = await tx.query('SELECT * FROM improvement_skill_selections WHERE "runId"=$1', [runId])
      if (!selection) return {}
      if (!supportsArtifacts) throw new ImprovementError('workerCapabilityRequired')
      const run = await owned(tx, userId, runId)
      if (run.status !== 'preparing' || run.deviceId !== deviceId || !run.startedAt || !run.leaseExpiresAt ||
        run.leaseExpiresAt.getTime() !== new Date(leaseExpiresAt).getTime() || run.leaseExpiresAt.getTime() <= Date.now() ||
        selection.userId !== userId || selection.issueId !== run.issueId || selection.agentId !== run.agentId ||
        selection.repoId !== run.deviceRepoId || selection.deviceId !== deviceId || selection.versionId !== BASELINE_ARTIFACT.versionId)
        throw new ImprovementError('runUnavailable')
      await version(tx)
      const receipt = skillAssignmentReceiptSchema.parse({ id: randomUUID(), runId, issueId: run.issueId,
        agentId: run.agentId, repoId: run.deviceRepoId, deviceId, leaseExpiresAt,
        assignedAt: new Date().toISOString(), artifact: BASELINE_ARTIFACT })
      await tx.query('INSERT INTO improvement_skill_receipts(id,"runId","userId",receipt) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [receipt.id, runId, userId, JSON.stringify(receipt)])
      const { rows: [stored] } = await tx.query('SELECT * FROM improvement_skill_receipts WHERE "runId"=$1', [runId])
      const parsed = skillAssignmentReceiptSchema.parse(stored.receipt)
      if (stored.userId !== userId || parsed.runId !== runId || parsed.leaseExpiresAt !== leaseExpiresAt ||
        digest(parsed.artifact) !== digest(BASELINE_ARTIFACT)) throw new ImprovementError('conflict')
      return { skills: [BASELINE_SKILL], skillReceipt: parsed }
    })
  }
  async function revalidate(userId:string,runId:string,receiptId:string,supportsArtifacts:boolean) {
    if (!supportsArtifacts) throw new ImprovementError('workerCapabilityRequired')
    return transaction(async tx=>{
      const run=await owned(tx,userId,runId)
      if (!['preparing','running','waiting_input','finishing'].includes(run.status)||!run.leaseExpiresAt||run.leaseExpiresAt.getTime()<=Date.now())
        throw new ImprovementError('runUnavailable')
      const source=await assignedSkillForRun(tx,userId,run)
      if (source.skillUsage!=='assigned'||source.skillReceipt.id!==receiptId||digest(source.skillArtifact)!==digest(BASELINE_ARTIFACT))
        throw new ImprovementError('sourceMismatch')
      return {skillReceipt:source.skillReceipt,leaseExpiresAt:run.leaseExpiresAt.toISOString()}
    })
  }
  async function renewHeartbeat(userId:string,deviceId:string,runIds:string[],supportsArtifacts:boolean) {
    const {rows}=await pool.query(`WITH RECURSIVE lineage AS (
      SELECT id AS root,id,"retryOf" FROM agent_runs WHERE "userId"=$1 AND id=ANY($2::uuid[])
      UNION SELECT l.root,r.id,r."retryOf" FROM agent_runs r JOIN lineage l ON r.id=l."retryOf"
    ) SELECT run.id AS "runId",receipt.id,(s."runId" IS NOT NULL) AS selected FROM agent_runs run
      LEFT JOIN improvement_skill_selections s ON s."runId"=run.id AND s."userId"=$1
      LEFT JOIN improvement_skill_receipts receipt ON receipt."runId"=run.id AND receipt."userId"=$1
      WHERE run."userId"=$1 AND run.id=ANY($2::uuid[]) AND (s."runId" IS NOT NULL OR EXISTS (
        SELECT 1 FROM lineage l JOIN factory_attempts a ON a."runId"=l.id WHERE l.root=run.id))`,[userId,runIds])
    const revoked:string[]=[],leases:Record<string,string>={}
    for(const row of rows) {
      try {
        if(row.selected&&(!supportsArtifacts||!row.id))throw new ImprovementError('workerCapabilityRequired')
        leases[row.runId]=await transaction(async tx=>{
          const run=await owned(tx,userId,row.runId,true)
          if(run.deviceId!==deviceId||!['preparing','running','waiting_input','finishing'].includes(run.status)||!run.leaseExpiresAt||run.leaseExpiresAt.getTime()<=Date.now())
            throw new ImprovementError('runUnavailable')
          const source=row.selected ? await assignedSkillForRun(tx,userId,run) : null
          if(row.selected && (source?.skillUsage!=='assigned'||source.skillReceipt.id!==row.id||digest(source.skillArtifact)!==digest(BASELINE_ARTIFACT)))throw new ImprovementError('sourceMismatch')
          const expiry=new Date(Date.now()+RUN_LEASE_MS).toISOString()
          const changed=await tx.query(`UPDATE agent_runs SET "leaseExpiresAt"=$4,"updatedAt"=now() WHERE id=$1 AND "userId"=$2 AND "deviceId"=$3
            AND "stopRequestedAt" IS NULL AND "leaseExpiresAt"=$5 AND "leaseExpiresAt">now() RETURNING id`,[run.id,userId,deviceId,expiry,run.leaseExpiresAt])
          if(!changed.rowCount)throw new ImprovementError('runUnavailable')
          return expiry
        })
      }
      catch(error) {if (!(error instanceof ImprovementError)) throw error;revoked.push(row.runId)}
    }
    const protectedIds=new Set(rows.map(row=>row.runId))
    return {legacy:runIds.filter(id=>!protectedIds.has(id)),leases,revoked}
  }
  return { selectBaseline, preflight, recordClaim, revalidate, renewHeartbeat }
}

/** Trust only an immutable server ledger bound to this actual live source. */
export async function assignedSkillForRun(tx: PoolClient, userId: string, run: {
  id: string; issueId: string; agentId: string; deviceRepoId: string; deviceId: string; startedAt?: Date | null
}) {
  const { rows: [row] } = await tx.query(`SELECT s.*,v.artifact,v.markdown FROM improvement_skill_receipts s
    JOIN improvement_skill_versions v ON v.id=(s.receipt->'artifact'->>'versionId')::uuid
    WHERE s."runId"=$1 AND s."userId"=$2`, [run.id, userId])
  if (!row) return { skillUsage: 'unrecorded' as const }
  const receipt = skillAssignmentReceiptSchema.safeParse(row.receipt)
  if (!receipt.success || receipt.data.issueId !== run.issueId || receipt.data.agentId !== run.agentId ||
    receipt.data.repoId !== run.deviceRepoId || receipt.data.deviceId !== run.deviceId || !run.startedAt ||
    new Date(receipt.data.assignedAt).getTime() < run.startedAt.getTime() ||
    digest(row.artifact) !== digest(receipt.data.artifact) ||
    createHash('sha256').update(row.markdown,'utf8').digest('hex') !== receipt.data.artifact.sha256)
    throw new ImprovementError('sourceMismatch')
  return { skillUsage: 'assigned' as const, skillReceipt: receipt.data, skillArtifact: receipt.data.artifact,
    usageClaim: 'server_prepared_assignment_not_execution' as const }
}
