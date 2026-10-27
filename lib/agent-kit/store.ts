import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { canonicalJSON, digest, makeSnapshot, parseDefinition, type AgentDefinition, type DefinitionSnapshot } from './definition'
import { compareReports, type EvalReport } from './evals'
import { assertSafeImprovement, caseFromFailure, proposeImprovement, type FailureCode, type FailureEvidence } from './improvement'

export interface AgentScope { ownerId: string; botId: string | null; workspaceId: string | null }
export interface DefinitionVersion { id: string; version: number; definition: AgentDefinition; digest: string; source: 'builtin' | 'user' | 'improvement'; base_version: string | null }
export interface AgentExecution { id: string; snapshot: DefinitionSnapshot; status: 'running' | 'completed' | 'failed' }
export interface ImprovementProposal { id: string; baseline_id: string; candidate_id: string; evidence: FailureEvidence[]; rationale: string; status: 'proposed' | 'approved' | 'rejected' }
export interface EvaluationRecord { id: string; proposal_id: string; mode: 'fixture' | 'live'; model: string | null; status: 'running' | 'completed' | 'failed'; reports: { baseline: EvalReport; candidate: EvalReport } | null }
export class AgentKitError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); this.name = 'AgentKitError' }
}
const key = (scope: AgentScope) => scope.botId ?? 'coordinator'
const params = (scope: AgentScope) => [scope.ownerId, key(scope)]
const uuid = (input: string) => z.uuid().parse(input)

/** All SQL is scoped by actor and bot. No dynamic SQL, user code, or external effects. */
export class AgentKitStore {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try { await client.query('begin'); const result = await fn(client); await client.query('commit'); return result }
    catch (error) { await client.query('rollback'); throw error }
    finally { client.release() }
  }
  private async authority(client: PoolClient, scope: AgentScope) {
    z.string().min(1).max(256).parse(scope.ownerId)
    if (scope.botId) {
      uuid(scope.botId); if (!scope.workspaceId) throw new AgentKitError('agentScopeNotFound', 404)
      uuid(scope.workspaceId)
      const result = await client.query('select id from bots where id=$1 and "ownerId"=$2 and "workspaceId"=$3 for key share', [scope.botId, scope.ownerId, scope.workspaceId])
      if (!result.rowCount) throw new AgentKitError('agentScopeNotFound', 404)
    } else {
      if (scope.workspaceId !== null) throw new AgentKitError('agentScopeNotFound', 404)
      const result = await client.query('select id from "user" where id=$1 for key share', [scope.ownerId])
      if (!result.rowCount) throw new AgentKitError('agentScopeNotFound', 404)
    }
  }
  private async version(client: PoolClient, scope: AgentScope, id: string): Promise<DefinitionVersion> {
    const { rows } = await client.query<DefinitionVersion>('select id,version,definition,digest,source,base_version from agent_kit_versions where owner_id=$1 and bot_key=$2 and id=$3', [...params(scope), uuid(id)])
    if (!rows[0]) throw new AgentKitError('agentVersionNotFound', 404)
    return { ...rows[0], definition: parseDefinition(rows[0].definition) }
  }
  private async insertVersion(client: PoolClient, scope: AgentScope, definition: AgentDefinition, source: DefinitionVersion['source'], requestKey: string, baseId: string | null): Promise<DefinitionVersion> {
    const id = randomUUID()
    const { rows } = await client.query<{ next_version: number }>('update agent_kit_heads set next_version=next_version+1 where owner_id=$1 and bot_key=$2 returning next_version-1 as next_version', params(scope))
    const version = rows[0].next_version
    const hash = digest(definition)
    await client.query('insert into agent_kit_versions(id,owner_id,bot_key,version,definition,digest,source,request_key,base_version) values($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id,...params(scope),version,JSON.stringify(definition),hash,source,requestKey,baseId])
    return { id, version, definition, digest: hash, source, base_version: baseId }
  }
  private async head(client: PoolClient, scope: AgentScope, defaults: AgentDefinition): Promise<DefinitionVersion> {
    await this.authority(client, scope)
    await client.query('insert into agent_kit_heads(owner_id,bot_key,bot_id,workspace_id) values($1,$2,$3,$4) on conflict do nothing', [...params(scope),scope.botId,scope.workspaceId])
    const { rows } = await client.query<{ active_version: string | null; workspace_id: string | null }>('select active_version,workspace_id from agent_kit_heads where owner_id=$1 and bot_key=$2 for update', params(scope))
    if (rows[0].workspace_id !== scope.workspaceId) throw new AgentKitError('agentScopeNotFound', 404)
    if (rows[0].active_version) return this.version(client,scope,rows[0].active_version)
    const initial = await this.insertVersion(client,scope,parseDefinition(defaults),'builtin','builtin',null)
    await client.query('update agent_kit_heads set active_version=$3 where owner_id=$1 and bot_key=$2',[...params(scope),initial.id])
    return initial
  }
  async active(scope: AgentScope, defaults: AgentDefinition) { return this.transaction(client => this.head(client,scope,defaults)) }
  async history(scope: AgentScope) {
    return this.transaction(async client => {
      await this.authority(client,scope)
      const { rows } = await client.query('select id,version,digest,source,base_version,created_at from agent_kit_versions where owner_id=$1 and bot_key=$2 order by version desc limit 100',params(scope))
      return rows
    })
  }
  private async activate(client: PoolClient, scope: AgentScope, from: string, to: string, requestKey: string, reason: 'edit' | 'rollback' | 'approved_improvement', evaluationId: string | null = null) {
    await client.query('update agent_kit_heads set active_version=$3 where owner_id=$1 and bot_key=$2',[...params(scope),to])
    await client.query('insert into agent_kit_activations(id,owner_id,bot_key,from_version,to_version,request_key,reason,evaluation_id) values($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),...params(scope),from,to,requestKey,reason,evaluationId])
  }
  async save(scope: AgentScope, input: unknown, expectedVersion: number, requestId: string, defaults: AgentDefinition) {
    const definition = parseDefinition(input); uuid(requestId)
    return this.transaction(async client => {
      const current = await this.head(client,scope,defaults)
      const previous = await client.query<{ id: string; digest: string; base_version: string }>('select id,digest,base_version from agent_kit_versions where owner_id=$1 and bot_key=$2 and request_key=$3',[...params(scope),`edit:${requestId}`])
      if (previous.rows[0]) {
        const base = await this.version(client,scope,previous.rows[0].base_version)
        if (previous.rows[0].digest !== digest(definition) || base.version !== expectedVersion) throw new AgentKitError('agentRequestConflict')
        return this.version(client,scope,previous.rows[0].id)
      }
      if (current.version !== expectedVersion) throw new AgentKitError('agentVersionConflict')
      const next = await this.insertVersion(client,scope,definition,'user',`edit:${requestId}`,current.id)
      await this.activate(client,scope,current.id,next.id,requestId,'edit')
      return next
    })
  }
  async rollback(scope: AgentScope, targetId: string, expectedVersion: number, requestId: string, defaults: AgentDefinition) {
    uuid(requestId); uuid(targetId)
    return this.transaction(async client => {
      const current = await this.head(client,scope,defaults)
      const replay = await client.query<{ from_version: string; to_version: string; reason: string }>('select from_version,to_version,reason from agent_kit_activations where owner_id=$1 and bot_key=$2 and request_key=$3',[...params(scope),requestId])
      if (replay.rows[0]) {
        const base = await this.version(client,scope,replay.rows[0].from_version)
        if (replay.rows[0].to_version !== targetId || replay.rows[0].reason !== 'rollback' || base.version !== expectedVersion) throw new AgentKitError('agentRequestConflict')
        return this.version(client,scope,targetId)
      }
      if (current.version !== expectedVersion) throw new AgentKitError('agentVersionConflict')
      const target = await this.version(client,scope,targetId)
      // A generated, unevaluated candidate is not a rollback target.
      if (target.source === 'improvement') {
        const activation = await client.query('select 1 from agent_kit_activations where owner_id=$1 and bot_key=$2 and to_version=$3',[...params(scope),target.id])
        if (!activation.rowCount) throw new AgentKitError('agentCandidateNotApproved')
      }
      await this.activate(client,scope,current.id,target.id,requestId,'rollback')
      return target
    })
  }
  async beginExecution(scope: AgentScope, executionKey: string, hostInstructions: string, runtime: DefinitionSnapshot['runtime'], defaults: AgentDefinition): Promise<AgentExecution> {
    z.string().min(1).max(240).parse(executionKey)
    return this.transaction(async client => {
      const current = await this.head(client,scope,defaults)
      const existing = await client.query<AgentExecution>('select id,snapshot,status from agent_kit_executions where owner_id=$1 and bot_key=$2 and execution_key=$3',[...params(scope),executionKey])
      if (existing.rows[0]) return existing.rows[0]
      const id = randomUUID(); const snapshot = makeSnapshot(current.id,current.version,current.definition,hostInstructions,runtime)
      await client.query('insert into agent_kit_executions(id,owner_id,bot_key,execution_key,version_id,snapshot) values($1,$2,$3,$4,$5,$6)',[id,...params(scope),executionKey,current.id,JSON.stringify(snapshot)])
      return { id,snapshot,status:'running' }
    })
  }
  private async execution(client: PoolClient, scope: AgentScope, id: string, lock = false): Promise<AgentExecution> {
    await this.authority(client,scope)
    const { rows } = await client.query<AgentExecution>(`select id,snapshot,status from agent_kit_executions where owner_id=$1 and bot_key=$2 and id=$3${lock ? ' for update' : ''}`,[...params(scope),uuid(id)])
    if (!rows[0]) throw new AgentKitError('agentExecutionNotFound',404)
    return rows[0]
  }
  async readExecution(scope: AgentScope, id: string) { return this.transaction(client => this.execution(client,scope,id)) }
  private async event(client: PoolClient, scope: AgentScope, executionId: string, eventKey: string, kind: string, payload: Record<string, unknown>) {
    z.string().min(1).max(240).parse(eventKey)
    const previous = await client.query<{ kind: string; payload: unknown }>('select kind,payload from agent_kit_events where execution_id=$1 and event_key=$2',[executionId,eventKey])
    if (previous.rows[0]) {
      if (previous.rows[0].kind !== kind || canonicalJSON(previous.rows[0].payload) !== canonicalJSON(payload)) throw new AgentKitError('agentEventConflict')
      return
    }
    await client.query('insert into agent_kit_events(execution_id,owner_id,bot_key,event_key,kind,payload) values($1,$2,$3,$4,$5,$6)',[executionId,...params(scope),eventKey,kind,JSON.stringify(payload)])
  }
  async recordTool(scope: AgentScope, executionId: string, callId: string, toolName: string, phase: 'start' | 'finish', outcome?: 'ok' | 'error' | 'approval_pending') {
    z.string().min(1).max(180).parse(callId)
    return this.transaction(async client => {
      const execution = await this.execution(client,scope,executionId,true)
      if (!execution.snapshot.effectiveTools.includes(toolName)) throw new AgentKitError('agentToolNotAllowed',403)
      const eventKey = `${callId}:${phase}`
      if (execution.status !== 'running') {
        const old = await client.query('select 1 from agent_kit_events where execution_id=$1 and event_key=$2',[executionId,eventKey])
        if (!old.rowCount) throw new AgentKitError('agentExecutionClosed')
      }
      await this.event(client,scope,executionId,eventKey,phase === 'start' ? 'tool_started' : 'tool_finished',{ toolName, ...(phase === 'finish' ? { outcome: outcome ?? 'error' } : {}) })
      if (phase === 'finish' && outcome === 'error' && execution.snapshot.definition.hooks.includes('failure_cases')) {
        const evidence: FailureEvidence = { executionId,code:'tool_error',toolName }
        const old = await client.query('select 1 from agent_kit_events where execution_id=$1 and event_key=$2',[executionId,'failure'])
        if (!old.rowCount) await this.event(client,scope,executionId,'failure','failure_case',{ evidence, testCase:caseFromFailure(evidence) })
      }
    })
  }
  async finishExecution(scope: AgentScope, executionId: string, status: 'completed' | 'failed', failure?: FailureCode) {
    return this.transaction(async client => {
      const execution = await this.execution(client,scope,executionId,true)
      await this.event(client,scope,executionId,'finished','run_finished',{ status, failure:failure ?? null })
      if (execution.status === 'running') await client.query('update agent_kit_executions set status=$2,finished_at=now() where id=$1',[executionId,status])
      if (failure && execution.snapshot.definition.hooks.includes('failure_cases')) {
        const previous = await client.query('select 1 from agent_kit_events where execution_id=$1 and event_key=$2',[executionId,'failure'])
        if (!previous.rowCount) {
          const evidence: FailureEvidence = { executionId,code:failure,toolName:null }
          await this.event(client,scope,executionId,'failure','failure_case',{ evidence, testCase:caseFromFailure(evidence) })
        }
      }
    })
  }
  async dataset(scope: AgentScope) {
    return this.transaction(async client => {
      await this.authority(client,scope)
      const { rows } = await client.query('select e.execution_id,e.payload,e.created_at,x.version_id from agent_kit_events e join agent_kit_executions x on x.id=e.execution_id where e.owner_id=$1 and e.bot_key=$2 and e.kind=$3 order by e.created_at desc limit 100',[...params(scope),'failure_case'])
      return rows
    })
  }
  async propose(scope: AgentScope, expectedVersion: number, requestId: string, defaults: AgentDefinition): Promise<ImprovementProposal> {
    uuid(requestId)
    return this.transaction(async client => {
      const baseline = await this.head(client,scope,defaults)
      const existing = await client.query<ImprovementProposal>('select * from agent_kit_proposals where owner_id=$1 and bot_key=$2 and request_key=$3',[...params(scope),requestId])
      if (existing.rows[0]) {
        if ((await this.version(client,scope,existing.rows[0].baseline_id)).version !== expectedVersion) throw new AgentKitError('agentRequestConflict')
        return existing.rows[0]
      }
      if (baseline.version !== expectedVersion) throw new AgentKitError('agentVersionConflict')
      const { rows } = await client.query<{ payload: { evidence: FailureEvidence } }>('select e.payload from agent_kit_events e join agent_kit_executions x on x.id=e.execution_id where e.owner_id=$1 and e.bot_key=$2 and e.kind=$3 and x.version_id=$4 order by e.created_at desc limit 50',[...params(scope),'failure_case',baseline.id])
      const evidence = rows.map(row => row.payload.evidence)
      let generated: ReturnType<typeof proposeImprovement>
      try { generated = proposeImprovement(baseline.definition,evidence) } catch (error) { throw new AgentKitError(error instanceof Error ? error.message : 'agentImprovementFailed') }
      const id = randomUUID()
      const candidate = await this.insertVersion(client,scope,generated.definition,'improvement',`proposal:${requestId}`,baseline.id)
      await client.query('insert into agent_kit_proposals(id,owner_id,bot_key,baseline_id,candidate_id,request_key,evidence,rationale) values($1,$2,$3,$4,$5,$6,$7,$8)',[id,...params(scope),baseline.id,candidate.id,requestId,JSON.stringify(evidence),generated.rationale])
      return { id,baseline_id:baseline.id,candidate_id:candidate.id,evidence,rationale:generated.rationale,status:'proposed' }
    })
  }
  async proposals(scope: AgentScope) {
    return this.transaction(async client => { await this.authority(client,scope); return (await client.query<ImprovementProposal>('select * from agent_kit_proposals where owner_id=$1 and bot_key=$2 order by created_at desc limit 100',params(scope))).rows })
  }
  async beginEvaluation(scope: AgentScope, proposalId: string, requestId: string, mode: 'fixture' | 'live', model: string | null) {
    uuid(proposalId);uuid(requestId)
    return this.transaction(async client => {
      await this.authority(client,scope)
      const { rows } = await client.query<ImprovementProposal>('select * from agent_kit_proposals where owner_id=$1 and bot_key=$2 and id=$3 for update',[...params(scope),proposalId])
      const proposal = rows[0]
      if (!proposal) throw new AgentKitError('agentProposalNotFound',404)
      const prior = await client.query<EvaluationRecord>('select * from agent_kit_evaluations where owner_id=$1 and bot_key=$2 and request_key=$3',[...params(scope),requestId])
      if (prior.rows[0]) {
        if (prior.rows[0].proposal_id !== proposalId || prior.rows[0].mode !== mode || prior.rows[0].model !== model) throw new AgentKitError('agentRequestConflict')
        return { replayed:true as const, evaluation:prior.rows[0] }
      }
      if (proposal.status !== 'proposed') throw new AgentKitError('agentProposalClosed')
      const id=randomUUID()
      await client.query('insert into agent_kit_evaluations(id,owner_id,bot_key,proposal_id,request_key,mode,model) values($1,$2,$3,$4,$5,$6,$7)',[id,...params(scope),proposalId,requestId,mode,model])
      return { replayed:false as const, evaluation:{ id,proposal_id:proposalId,mode,model,status:'running' as const,reports:null }, baseline:await this.version(client,scope,proposal.baseline_id),candidate:await this.version(client,scope,proposal.candidate_id),evidence:proposal.evidence }
    })
  }
  async finishEvaluation(scope: AgentScope, id: string, reports: EvaluationRecord['reports']) {
    return this.transaction(async client => {
      await this.authority(client,scope)
      const { rows } = await client.query<EvaluationRecord>('select * from agent_kit_evaluations where owner_id=$1 and bot_key=$2 and id=$3 for update',[...params(scope),uuid(id)])
      const evaluation=rows[0]
      if (!evaluation) throw new AgentKitError('agentEvaluationNotFound',404)
      if (evaluation.status !== 'running') {
        if (canonicalJSON(evaluation.reports) !== canonicalJSON(reports)) throw new AgentKitError('agentEvaluationConflict')
        return evaluation
      }
      if (reports && (reports.baseline.mode !== evaluation.mode || reports.candidate.mode !== evaluation.mode || reports.baseline.model !== evaluation.model || reports.candidate.model !== evaluation.model)) throw new AgentKitError('agentEvaluationMismatch')
      const status=reports ? 'completed' : 'failed'
      await client.query('update agent_kit_evaluations set status=$2,reports=$3,finished_at=now() where id=$1',[id,status,JSON.stringify(reports)])
      return { ...evaluation,status,reports }
    })
  }
  async approve(scope: AgentScope, proposalId: string, evaluationId: string, expectedVersion: number, requestId: string, defaults: AgentDefinition) {
    uuid(proposalId);uuid(evaluationId);uuid(requestId)
    return this.transaction(async client => {
      const active=await this.head(client,scope,defaults)
      const { rows }=await client.query<ImprovementProposal>('select * from agent_kit_proposals where owner_id=$1 and bot_key=$2 and id=$3 for update',[...params(scope),proposalId])
      const proposal=rows[0]
      if (!proposal) throw new AgentKitError('agentProposalNotFound',404)
      if (proposal.status === 'approved') {
        const replay = (await client.query<{ from_version: string; to_version: string; reason: string; evaluation_id: string | null }>('select from_version,to_version,reason,evaluation_id from agent_kit_activations where owner_id=$1 and bot_key=$2 and request_key=$3',[...params(scope),requestId])).rows[0]
        const base = await this.version(client,scope,proposal.baseline_id)
        const evidence = (await client.query<EvaluationRecord>('select * from agent_kit_evaluations where owner_id=$1 and bot_key=$2 and proposal_id=$3 and id=$4',[...params(scope),proposalId,evaluationId])).rows[0]
        if (replay?.evaluation_id === evaluationId && replay.reason === 'approved_improvement' && replay.to_version === proposal.candidate_id && replay.from_version === proposal.baseline_id && base.version === expectedVersion && evidence?.status === 'completed') return this.version(client,scope,proposal.candidate_id)
        throw new AgentKitError('agentRequestConflict')
      }
      if (proposal.status !== 'proposed') throw new AgentKitError('agentProposalClosed')
      if (active.version !== expectedVersion || active.id !== proposal.baseline_id) throw new AgentKitError('agentVersionConflict')
      const evaluation=(await client.query<EvaluationRecord>('select * from agent_kit_evaluations where owner_id=$1 and bot_key=$2 and proposal_id=$3 and id=$4',[...params(scope),proposalId,evaluationId])).rows[0]
      const candidate=await this.version(client,scope,proposal.candidate_id)
      if (!evaluation?.reports || evaluation.status !== 'completed' || evaluation.mode !== 'live' || evaluation.reports.baseline.definitionDigest !== active.digest || evaluation.reports.candidate.definitionDigest !== candidate.digest || !compareReports(evaluation.reports.baseline,evaluation.reports.candidate).activationEligible) throw new AgentKitError('agentEvaluationNotEligible')
      assertSafeImprovement(active.definition,candidate.definition)
      await this.activate(client,scope,active.id,candidate.id,requestId,'approved_improvement',evaluationId)
      await client.query('update agent_kit_proposals set status=$2,decided_at=now() where id=$1',[proposalId,'approved'])
      return candidate
    })
  }
  async reject(scope: AgentScope, proposalId: string) {
    return this.transaction(async client => {
      await this.authority(client,scope)
      const { rows }=await client.query('update agent_kit_proposals set status=$4,decided_at=now() where owner_id=$1 and bot_key=$2 and id=$3 and status=$5 returning id,status',[...params(scope),uuid(proposalId),'rejected','proposed'])
      if (!rows[0]) throw new AgentKitError('agentProposalClosed')
      return rows[0]
    })
  }
}
