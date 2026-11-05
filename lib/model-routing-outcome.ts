import 'server-only'
import { factoryEventId } from './factory/event-id'

type Query = { query: (text: string, values?: unknown[]) => Promise<unknown> }

/** Record the frozen choice and observed terminal result in the existing
 * ledger. Completion/recovery replays share one key; no task text is copied. */
export async function recordModelRoutingOutcome(query: Query, userId: string, runId: string) {
  await query.query(`INSERT INTO factory_events ("taskId","eventId",request,result)
    SELECT t.id,$3,jsonb_build_object('kind','model_routing_outcome','runId',r.id),
      jsonb_build_object('runId',r.id,'routing',r."agentDefinition"->'modelDispatch'->'routing',
        'outcome',jsonb_build_object('status',r.status,'stopReason',r."stopReason",'stage',a.stage,'attemptStatus',a.status))
    FROM agent_runs r JOIN factory_attempts a ON a."runId"=r.id
    JOIN factory_tasks t ON t.id=a."taskId" AND t."userId"=r."userId" AND t."issueId"=r."issueId"
    WHERE r.id=$1 AND r."userId"=$2 AND r.status IN ('succeeded','stopped','failed','cancelled')
      AND r."agentDefinition"->'modelDispatch'->'routing' IS NOT NULL
    ON CONFLICT ("taskId","eventId") DO NOTHING`, [runId, userId, factoryEventId('model-routing-outcome', runId)])
}
