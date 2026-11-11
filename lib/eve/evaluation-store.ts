import {randomUUID} from 'node:crypto'
import type {Pool} from 'pg'
import type {AgentScope} from '../agent-kit/store'
import type {DefinitionSnapshot} from '../agent-kit/definition'
import type {EvalCase} from '../agent-kit/evals'
import type {ProductCatalogueEntry} from './product-rpc'
import type {EveScope} from './scope'

export interface EvaluationPlan {
  scope:AgentScope
  snapshot:DefinitionSnapshot
  testCase:EvalCase
  instructions:string
  tools:ProductCatalogueEntry[]
}
export interface EvaluationBinding {id:string;session_id:string|null;plan:EvaluationPlan}

/** Host-only preparation. The frozen execution and selected proposal revision
 * must belong to the same evaluation; request JSON never supplies this plan. */
export async function createEvaluationBinding(pool:Pool,scope:EveScope,evaluationId:string,versionId:string,plan:EvaluationPlan):Promise<string> {
  if(plan.scope.ownerId!==scope.ownerId||(plan.scope.botId!==null&&plan.scope.botId!==scope.botId)||(plan.scope.workspaceId!==null&&plan.scope.workspaceId!==scope.workspaceId)||plan.snapshot.revisionId!==versionId)throw new Error('agentEvaluationMismatch')
  const id=randomUUID()
  const result=await pool.query(`INSERT INTO eve_evaluations(id,owner_id,bot_id,workspace_id,evaluation_id,version_id,plan)
    SELECT $1,$2,$3,$4,e.id,$6,$7 FROM agent_kit_evaluations e
    JOIN agent_kit_proposals p ON p.id=e.proposal_id AND p.owner_id=e.owner_id AND p.bot_key=e.bot_key
    JOIN agent_kit_versions v ON v.id=$6 AND v.owner_id=e.owner_id AND v.bot_key=e.bot_key
    JOIN agent_kit_executions x ON x.owner_id=e.owner_id AND x.bot_key=e.bot_key AND x.execution_key='evaluation:'||e.request_key
    WHERE e.id=$5 AND e.owner_id=$2 AND e.bot_key=$8 AND e.mode='live' AND e.status='running' AND x.status='running'
      AND $6::uuid IN(p.baseline_id,p.candidate_id) AND x.snapshot->'runtime'=$9::jsonb
      AND v.definition=$10::jsonb AND x.snapshot->>'hostInstructionsDigest'=$11 RETURNING id`,
  [id,scope.ownerId,scope.botId,scope.workspaceId,evaluationId,versionId,JSON.stringify(plan),plan.scope.botId??'coordinator',JSON.stringify(plan.snapshot.runtime),JSON.stringify(plan.snapshot.definition),plan.snapshot.hostInstructionsDigest])
  if(!result.rowCount)throw new Error('agentEvaluationMismatch')
  return id
}

export async function loadEvaluationBinding(pool:Pool,scope:EveScope,id:string):Promise<EvaluationBinding|null> {
  return (await pool.query<EvaluationBinding>(`SELECT b.id,b.session_id,b.plan FROM eve_evaluations b
    JOIN agent_kit_evaluations e ON e.id=b.evaluation_id AND e.owner_id=b.owner_id
    WHERE b.id=$1 AND b.owner_id=$2 AND b.bot_id=$3 AND b.workspace_id=$4`,[id,scope.ownerId,scope.botId,scope.workspaceId])).rows[0]??null
}
export async function bindEvaluationSession(pool:Pool,id:string,sessionId:string) {
  const row=await pool.query('UPDATE eve_evaluations SET session_id=$2 WHERE id=$1 AND (session_id IS NULL OR session_id=$2) RETURNING id',[id,sessionId])
  if(!row.rowCount)throw new Error('agentEvaluationMismatch')
}
