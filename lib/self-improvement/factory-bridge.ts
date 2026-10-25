import type { Pool } from 'pg'
import type { createFactoryStore } from '../factory/store'
import type { createFactoryDispatch } from '../factory/dispatch'
import { bindingSchema } from '../factory/contract'
import { BASELINE_ARTIFACT } from './builtin-skill'
import { assignedSkillForRun } from './assignments'
import { commandSchema, digest, ImprovementError, type ImprovementHandoff, type ImprovementRehearsal } from './contract'
import type { createSkillAssignments } from './assignments'

export function createImprovementFactoryBridge(pool: Pool, factory: ReturnType<typeof createFactoryStore>,
  dispatch: ReturnType<typeof createFactoryDispatch>, assignments:ReturnType<typeof createSkillAssignments>) {
  return {
    async rehearse(userId:string,input:ImprovementRehearsal) {
      const parsed=commandSchema.safeParse(input)
      if (!parsed.success || parsed.data.action!=='rehearse') throw new ImprovementError('invalid')
      const tx=await pool.connect(), req=parsed.data
      try {
        await tx.query('BEGIN')
        const task=await factory.lockForDispatch(userId,req.binding,req.binding.attemptId,tx)
        if (task.stage!=='execute') throw new ImprovementError('runUnavailable')
        const result=await dispatch(userId,{binding:req.binding,agentId:req.agentId,deviceRepoId:req.deviceRepoId},tx)
        const selection=await assignments.selectBaseline(userId,result.runId,tx)
        await tx.query('COMMIT')
        return {...result,selection,productionEligible:false}
      } catch(error) {await tx.query('ROLLBACK');throw error} finally {tx.release()}
    },
    async handoff(userId: string, input: ImprovementHandoff) {
      const parsed = commandSchema.safeParse(input)
      if (!parsed.success || parsed.data.action !== 'handoff') throw new ImprovementError('invalid')
      const req = parsed.data, tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`improvement-handoff:${userId}:${req.proposalId}`])
        const { rows: [proposal] } = await tx.query('SELECT * FROM improvement_proposals WHERE id=$1 AND "userId"=$2', [req.proposalId,userId])
        if (!proposal || proposal.issueId !== req.binding.issueId) throw new ImprovementError('notFound')
        const { rows: [previous] } = await tx.query('SELECT * FROM improvement_factory_links WHERE "proposalId"=$1', [req.proposalId])
        if (previous && digest(previous.request) !== digest(req)) throw new ImprovementError('conflict')
        // Current Factory authorization/fence still applies on replay. This
        // service never routes a request, creates an approval or passes a gate.
        const task = await factory.lockForDispatch(userId, req.binding, req.binding.attemptId, tx)
        if (task.stage !== 'execute') throw new ImprovementError('runUnavailable')
        if (previous) {
          await tx.query('COMMIT')
          return { ...previous, binding: bindingSchema.parse(req.binding), replayed: true, productionEligible: false }
        }
        const { rows: sources } = await tx.query(`SELECT r.*,s.snapshot,coalesce(repo."remoteUrl",repo."repoPath") AS repository FROM improvement_proposal_sources src
          JOIN improvement_scores s ON s.id=src."scoreId" JOIN agent_runs r ON r.id=src."runId"
          JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=$2
          WHERE src."proposalId"=$1 AND src."userId"=$2 ORDER BY r.id FOR SHARE OF r,repo`, [req.proposalId,userId])
        const { rows:[count] }=await tx.query('SELECT count(*)::int AS total FROM improvement_proposal_sources WHERE "proposalId"=$1 AND "userId"=$2',[req.proposalId,userId])
        if (!sources.length || sources.length!==count.total) throw new ImprovementError('sourceRequired')
        for (const run of sources) {
          if (run.userId !== userId || run.issueId !== proposal.issueId || run.stopRequestedAt ||
            req.deviceRepoId !== run.deviceRepoId || run.snapshot?.repository !== run.repository ||
            !['succeeded','failed'].includes(run.status) || run.snapshot?.skillUsage !== 'assigned') throw new ImprovementError('sourceRequired')
          const provenance = await assignedSkillForRun(tx,userId,run)
          if (provenance.skillUsage !== 'assigned' || digest(provenance.skillArtifact) !== digest(BASELINE_ARTIFACT) ||
            digest(run.snapshot.skillArtifact) !== digest(provenance.skillArtifact) ||
            run.snapshot.skillReceipt?.id !== provenance.skillReceipt.id) throw new ImprovementError('sourceMismatch')
        }
        if (!proposal.result?.noRegression || !proposal.result?.improved || proposal.result.productionEligible !== false)
          throw new ImprovementError('sourceMismatch')
        const note = `Controlled Skill improvement proposal ${proposal.id}.\nApply only this frozen inactive document diff:\n${proposal.candidate.diff}\nBaseline digest ${proposal.candidate.baselineDigest}; candidate digest ${proposal.candidate.candidateDigest}.\nDo not activate or distribute this Skill. Synthetic document comparison does not pass review, verification or approval. Produce a real candidate commit for the existing independent Factory gates.`
        const result = await dispatch(userId,{ binding:req.binding,agentId:req.agentId,deviceRepoId:req.deviceRepoId,note },tx)
        await tx.query(`INSERT INTO improvement_factory_links("proposalId","userId","issueId","taskId","attemptId","runId",request)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [req.proposalId,userId,proposal.issueId,req.binding.taskId,req.binding.attemptId,result.runId,JSON.stringify(req)])
        await tx.query('COMMIT')
        return { ...result, proposalId:req.proposalId, productionEligible:false }
      } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
    },
    async status(userId: string, proposalId: string) {
      const { rows:[link] } = await pool.query('SELECT * FROM improvement_factory_links WHERE "proposalId"=$1 AND "userId"=$2',[proposalId,userId])
      if (!link) throw new ImprovementError('notFound')
      const state = await factory.read(userId,link.taskId)
      return { link, factory:state, productionEligible:false }
    },
  }
}
