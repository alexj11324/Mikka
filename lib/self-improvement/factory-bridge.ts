import type { FactoryWorkspaceBoundary } from '../factory/background-workspace'
import type { Pool } from 'pg'
import { notifyQueuedLocalRun } from '../device-gateway-notify'
import type { createFactoryStore } from '../factory/store'
import type { createFactoryDispatch } from '../factory/dispatch'
import { bindingSchema } from '../factory/contract'
import { BASELINE_ARTIFACT, BASELINE_MARKDOWN } from './builtin-skill'
import { assignedSkillForRun } from './assignments'
import { commandSchema, digest, ImprovementError, type ImprovementHandoff, type ImprovementRehearsal } from './contract'
import type { createSkillAssignments } from './assignments'
import { createGenerationRequest, generationNote, failureQuality, type FailureQualityProvider } from './regression'

export function createImprovementFactoryBridge(pool: Pool, factory: ReturnType<typeof createFactoryStore>,
  dispatch: ReturnType<typeof createFactoryDispatch>, assignments:ReturnType<typeof createSkillAssignments>, qualityProvider?: FailureQualityProvider,
  // Host/test dependency only; request input never supplies a tenant or bypass.
  withWorkspace: FactoryWorkspaceBoundary = async (userId, taskId, work) =>
    (await import('../factory/background-workspace')).withFactoryBackgroundWorkspace(pool,userId,{kind:'task',id:taskId,botId:null},work)) {
  return {
    async rehearse(userId:string,input:ImprovementRehearsal) {
      const parsed=commandSchema.safeParse(input)
      if (!parsed.success || parsed.data.action!=='rehearse') throw new ImprovementError('invalid')
      const { beginFactoryTransaction, commitFactoryTransaction, rollbackFactoryTransaction, forgetFactoryTransaction } = await import('../factory/transaction')
      const req=parsed.data
      return withWorkspace(userId,req.binding.taskId,async()=>{
      const tx=await pool.connect()
      try {
        await beginFactoryTransaction(tx)
        const task=await factory.lockForDispatch(userId,req.binding,req.binding.attemptId,tx)
        if (task.stage!=='execute') throw new ImprovementError('runUnavailable')
        const result=await dispatch(userId,{binding:req.binding,agentId:req.agentId,deviceRepoId:req.deviceRepoId},tx)
        const selection=await assignments.selectBaseline(userId,result.runId,tx)
        await commitFactoryTransaction(tx)
        if (!result.replayed) await notifyQueuedLocalRun(tx, userId, result.runId)
        return {...result,selection,productionEligible:false}
      } catch(error) {await rollbackFactoryTransaction(tx);throw error} finally {forgetFactoryTransaction(tx);tx.release()}
      })
    },
    async handoff(userId: string, input: ImprovementHandoff) {
      const parsed = commandSchema.safeParse(input)
      if (!parsed.success || parsed.data.action !== 'handoff') throw new ImprovementError('invalid')
      const { beginFactoryTransaction, commitFactoryTransaction, rollbackFactoryTransaction, forgetFactoryTransaction } = await import('../factory/transaction')
      const req = parsed.data
      const { rows: [hint] } = await pool.query<{ issueId: string }>(
        'SELECT "issueId" FROM improvement_proposals WHERE id=$1 AND "userId"=$2', [req.proposalId,userId])
      if (!hint || hint.issueId !== req.binding.issueId) throw new ImprovementError('notFound')
      return withWorkspace(userId,req.binding.taskId,async()=>{
      const tx = await pool.connect()
      try {
        await beginFactoryTransaction(tx)
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`improvement-handoff:${userId}:${req.proposalId}`])
        const { rows: [proposal] } = await tx.query('SELECT * FROM improvement_proposals WHERE id=$1 AND "userId"=$2', [req.proposalId,userId])
        if (!proposal || proposal.issueId !== req.binding.issueId) throw new ImprovementError('notFound')
        const { rows: [previous] } = await tx.query('SELECT * FROM improvement_factory_links WHERE "proposalId"=$1', [req.proposalId])
        if (previous && digest(previous.request) !== digest(req)) throw new ImprovementError('conflict')
        // Current Factory authorization/fence still applies on replay. This
        // service never routes a request, creates an approval or passes a gate.
        const task = await factory.lockForDispatch(userId, req.binding, req.binding.attemptId, tx)
        if (task.stage !== 'execute') throw new ImprovementError('runUnavailable')
        const { rows: sources } = await tx.query(`SELECT r.*,s.snapshot,s.reason,s.outcome,s."scorerDigest",s.bucket AS "scoreBucket",src.bucket AS "sourceBucket",src."scoreId" AS "scoreId",coalesce(repo."remoteUrl",repo."repoPath") AS repository FROM improvement_proposal_sources src
          JOIN improvement_scores s ON s.id=src."scoreId" AND s."userId"=src."userId" JOIN agent_runs r ON r.id=src."runId" AND r.id=s."runId"
          JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=$2
          WHERE src."proposalId"=$1 AND src."userId"=$2 ORDER BY r.id FOR SHARE OF r,repo`, [req.proposalId,userId])
        const { rows:[count] }=await tx.query('SELECT count(*)::int AS total FROM improvement_proposal_sources WHERE "proposalId"=$1',[req.proposalId])
        if (!sources.length || sources.length!==count.total) throw new ImprovementError('sourceRequired')
        for (const run of sources) {
          if (run.userId !== userId || run.issueId !== proposal.issueId || run.agentId !== req.agentId || run.stopRequestedAt ||
            req.deviceRepoId !== run.deviceRepoId || run.snapshot?.repository !== run.repository ||
            !['succeeded','failed'].includes(run.status) || !run.sessionId || !run.finishedAt ||
            run.outcome !== 'failure' || run.scorerDigest !== proposal.scorerDigest || run.scoreBucket !== proposal.bucket || run.sourceBucket !== proposal.bucket ||
            run.snapshot?.runId !== run.id || run.snapshot?.issueId !== run.issueId || run.snapshot?.agentId !== run.agentId ||
            run.snapshot?.deviceRepoId !== run.deviceRepoId || run.snapshot?.sessionId !== run.sessionId ||
            run.snapshot?.skillUsage !== 'assigned') throw new ImprovementError('sourceRequired')
          const provenance = await assignedSkillForRun(tx,userId,run)
          if (run.snapshot.reportDigest !== digest(run.report) || provenance.skillUsage !== 'assigned' || digest(provenance.skillArtifact) !== digest(BASELINE_ARTIFACT) ||
            digest(run.snapshot.skillArtifact) !== digest(provenance.skillArtifact) ||
            run.snapshot.skillReceipt?.id !== provenance.skillReceipt.id) throw new ImprovementError('sourceMismatch')
        }
        const failures = sources.map(run => ({ ...run, id: run.scoreId, runId: run.id }))
        const expected = createGenerationRequest(failures, BASELINE_MARKDOWN, BASELINE_ARTIFACT, await failureQuality(qualityProvider, tx, userId, failures))
        if (proposal.status !== 'awaiting_model_candidate' || digest(proposal.candidate) !== digest(expected.candidate) ||
          digest(proposal.result) !== digest(expected.result)) throw new ImprovementError('sourceMismatch')
        if (previous) {
          await commitFactoryTransaction(tx)
          return { ...previous, binding: bindingSchema.parse(req.binding), replayed: true, productionEligible: false }
        }
        const note = generationNote(proposal.id, expected.candidate)
        const result = await dispatch(userId,{ binding:req.binding,agentId:req.agentId,deviceRepoId:req.deviceRepoId,note },tx)
        await tx.query(`INSERT INTO improvement_factory_links("proposalId","userId","issueId","taskId","attemptId","runId",request)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [req.proposalId,userId,proposal.issueId,req.binding.taskId,req.binding.attemptId,result.runId,JSON.stringify(req)])
        await commitFactoryTransaction(tx)
        if (!result.replayed) await notifyQueuedLocalRun(tx, userId, result.runId)
        return { ...result, proposalId:req.proposalId, productionEligible:false }
      } catch (error) { await rollbackFactoryTransaction(tx); throw error } finally { forgetFactoryTransaction(tx); tx.release() }
      })
    },
    async status(userId: string, proposalId: string) {
      const { rows:[link] } = await pool.query('SELECT * FROM improvement_factory_links WHERE "proposalId"=$1 AND "userId"=$2',[proposalId,userId])
      if (!link) throw new ImprovementError('notFound')
      const state = await factory.read(userId,link.taskId)
      return { link, factory:state, productionEligible:false }
    },
  }
}
