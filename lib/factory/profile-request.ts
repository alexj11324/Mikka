import 'server-only'
import type { Pool } from 'pg'
import { AgentProfileError } from './agent-profile-definition'
import { agentProfileReferenceSchema, BUILTIN_AGENT_PROFILE_ID } from './agent-profile-reference'
import { readProfileRow } from './agent-profile-store'
import { taskDestinationSchema, type TaskDestination } from '../task-destination'
import { taskAgentSchema, type TaskAgent } from '../task-create-command'
import { storedRunSettings } from '../task-run-settings'

/** A selection from the owner's task form is authoritative. Otherwise the
 * Coordinator may choose one of the owner's Agent 配置 itself (decision
 * 2026-11-15-1630): a Profile is content only and grants no permission. */
export async function requestedTaskSelection(pool: Pick<Pool, 'query'>, scope: { ownerId: string; workspaceId: string; botId: string },
  eventId: string | undefined, offered: string | undefined): Promise<{ profileId?: string; taskDestination?: TaskDestination; commandIssueId?: string; agent?: TaskAgent; model?: string }> {
  const chosen = async (selection: { taskDestination?: TaskDestination; commandIssueId?: string; agent?: TaskAgent; model?: string }) => {
    if (!offered) return selection
    // The retired built-in route is never chosen by a model.
    if (offered === BUILTIN_AGENT_PROFILE_ID) throw new AgentProfileError('agentProfilePinConflict')
    return { ...selection, profileId: (await readProfileRow(pool, scope, agentProfileReferenceSchema.parse(offered))).id }
  }
  if (!eventId) return chosen({})
  const { rows: [event] } = await pool.query(`SELECT e.payload,c."taskId" AS "commandIssueId" FROM coordinator_events e
    LEFT JOIN task_creation_receipts c ON c."taskId"=e."issueId" AND c."userId"=e."userId"
      AND c."workspaceId"=$4 AND c."requestId"::text=e.payload->>'taskCreationRequestId' AND e."deliveredAt" IS NOT NULL
    WHERE e.id=$1 AND e."userId"=$2 AND e."botId"=$3 AND e.kind='user_message'`, [eventId, scope.ownerId, scope.botId, scope.workspaceId])
  // Reuse the authenticated source read. Placement must not depend on the
  // model repeating the person's task-form choice in its tool arguments.
  const destination = taskDestinationSchema.safeParse(event?.payload?.taskDestination)
  const explicit = event?.payload?.taskCommand?.intent === 'create_and_dispatch'
  if (explicit && !event.commandIssueId) throw new AgentProfileError('factorySourceMismatch')
  // The command's Agent (task form or schedule) is the task's; a command without one is refused by dispatch.
  const agent = explicit ? taskAgentSchema.safeParse(event.payload.taskCommand.agent) : undefined
  // The command's model (an automation's), on its Agent; checked against 优先使用的模型 like any named model.
  const run = explicit ? storedRunSettings(event.payload.taskCommand.run, eventId) : undefined
  const selection = { ...(destination.success ? { taskDestination: destination.data } : {}), ...(explicit ? { commandIssueId: String(event.commandIssueId) } : {}),
    ...(agent?.success ? { agent: agent.data } : {}), ...(agent?.success && run?.model ? { model: run.model.id } : {}) }
  const selected = agentProfileReferenceSchema.safeParse(event?.payload?.profileId)
  if (selected.success) return { ...selection, profileId: selected.data }
  return chosen(selection)
}

/** Existing Profile-only callers keep their result and one source read. */
export async function requestedAgentProfile(pool: Pick<Pool, 'query'>, scope: { ownerId: string; workspaceId: string; botId: string },
  eventId: string | undefined, offered: string | undefined): Promise<string | undefined> {
  return (await requestedTaskSelection(pool, scope, eventId, offered)).profileId
}
