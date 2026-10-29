import 'server-only'
import { ActionFailureError } from '@/lib/action-error'
import { pool } from '@/lib/db'
import { activitySources, encodeActivityCursor, parseActivityInput } from './activity-cursor'
import type { CredentialUseResult } from './saved-logins'

/**
 * The person's read-only activity timeline (settings). Three sources, all
 * filtered to the signed-in person:
 * - `credential_use`: a Bot used one of their saved logins
 *   (credential_access_events, written by lib/credentials/broker.ts)
 * - `external_action`: a proposal in their accounts that they approved or
 *   declined (pending_actions with decidedAt; only the owner decides them)
 * - `coordinator_reminder`: the Coordinator told them about a matter
 *   (attention_log action 'notify', with the recorded reason)
 * Summaries are structured; the UI composes the sentence with i18n.
 */
export type ActivityKind = 'credential_use' | 'external_action' | 'coordinator_reminder'

export type ActivitySummary =
  | { kind: 'credential_use'; site: string; account: string | null; credentialId: string | null; result: CredentialUseResult }
  | { kind: 'external_action'; action: string; decision: 'approved' | 'declined'; status: string; site: string | null; repository: string | null }
  | { kind: 'coordinator_reminder'; title: string; source: string; level: string; reason: string | null }

export interface ActivityTarget {
  /** Thread (agent run). */
  runId: string | null
  /** Cloud-browser subagent thread. */
  subagentId: string | null
  /** Task of the thread. */
  issueId: string | null
  pendingActionId: string | null
  /** Attention matter the reminder was about. */
  matterId: string | null
  /** The matter's source link, if it has one. */
  url: string | null
}

export interface ActivityItem {
  id: string
  kind: ActivityKind
  at: string
  botId: string | null
  botName: string | null
  summary: ActivitySummary
  target: ActivityTarget
  /** Who made the decision: the person, the Coordinator, or nobody (a Bot acting within its permission). */
  decidedBy: 'user' | 'coordinator' | null
}

export interface ActivityPage {
  items: ActivityItem[]
  nextCursor: string | null
}

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
const UUID_TEXT = `'${UUID_PATTERN}'`
const UUID = new RegExp(UUID_PATTERN)
const BROWSER_ACTIONS = `('credential_operation','browser_operation')`

const CREDENTIAL_ITEMS = `SELECT 'credential:' || e.id AS id, 'credential_use' AS kind, e.ts AS at,
    e.bot_id::text AS bot_id, e.run_id::text AS run_id, e.subagent_id::text AS subagent_id,
    NULL::text AS pending_action_id, NULL::text AS matter_id, NULL::text AS url,
    jsonb_build_object('kind','credential_use','site',e.origin_seen,'account',c.username,'credentialId',e.credential_id,'result',e.decision) AS summary,
    NULL::text AS decided_by
  FROM credential_access_events e
  LEFT JOIN credentials c ON c.id=e.credential_id AND c.user_id=$1
  WHERE e.user_id=$1`

// Bot and thread come from the run binding of approved writes, or from the
// plan of a cloud-browser/credential review. Other proposals record neither.
const ACTION_ITEMS = `SELECT 'action:' || p.id AS id, 'external_action' AS kind, p."decidedAt" AS at,
    COALESCE(p."operationBinding"->'run'->>'botId', CASE WHEN p.action IN ${BROWSER_ACTIONS} THEN p.input->>'botId' END) AS bot_id,
    p."operationBinding"->'run'->>'runId' AS run_id,
    CASE WHEN p.action IN ${BROWSER_ACTIONS} THEN p.input->>'subagentId' END AS subagent_id,
    p.id::text AS pending_action_id, NULL::text AS matter_id, NULL::text AS url,
    jsonb_build_object('kind','external_action','action',p.action,
      'decision',CASE WHEN p.status='declined' THEN 'declined' ELSE 'approved' END,'status',p.status,
      'site',CASE WHEN p.action IN ${BROWSER_ACTIONS} THEN p.input->>'origin' END,
      'repository',CASE WHEN p.action='approve_repository_push' THEN p.input->>'repo' END) AS summary,
    'user'::text AS decided_by
  FROM pending_actions p
  WHERE p."userId"=$1 AND p."decidedAt" IS NOT NULL`

const REMINDER_ITEMS = `SELECT 'reminder:' || l.id AS id, 'coordinator_reminder' AS kind, l."createdAt" AS at,
    NULL::text AS bot_id, NULL::text AS run_id, NULL::text AS subagent_id,
    NULL::text AS pending_action_id, l."matterId"::text AS matter_id, m.url AS url,
    jsonb_build_object('kind','coordinator_reminder','title',m.title,'source',m.source,'level',m.level,'reason',l.reason) AS summary,
    'coordinator'::text AS decided_by
  FROM attention_log l
  JOIN attention_matters m ON m.id=l."matterId" AND m."userId"=$1
  WHERE l."userId"=$1 AND l.action='notify'`

const ORDER = `ORDER BY at DESC, id COLLATE "C" DESC`
// $2 micros, $3 id, $4 page size + 1. Exact: timestamptz has microsecond precision.
const AFTER = `($2::bigint IS NULL OR at < 'epoch'::timestamptz + $2::bigint * interval '1 microsecond'
  OR (at = 'epoch'::timestamptz + $2::bigint * interval '1 microsecond' AND id COLLATE "C" < $3::text COLLATE "C"))`

const branch = (items: string) => `(SELECT * FROM (${items}) s WHERE ${AFTER} ${ORDER} LIMIT $4)`

const uuidOrNull = (value: string | null) => value && UUID.test(value) ? value : null

export async function activityFor(userId: string, input: unknown): Promise<ActivityPage> {
  const query = parseActivityInput(input)
  if (!query) throw new ActionFailureError('validationGeneric')
  const sources = activitySources(query.filter)
  const branches = [
    sources.credentials && branch(CREDENTIAL_ITEMS),
    sources.actions && branch(ACTION_ITEMS),
    sources.reminders && branch(REMINDER_ITEMS),
  ].filter(Boolean).join(' UNION ALL ')
  const { rows } = await pool.query(`SELECT page.*, (extract(epoch FROM page.at) * 1000000)::bigint::text AS micros,
      b.name AS bot_name, r."issueId" AS issue_id
    FROM (SELECT * FROM (${branches}) items ${ORDER} LIMIT $4) page
    LEFT JOIN bots b ON b.id=(CASE WHEN page.bot_id ~ ${UUID_TEXT} THEN page.bot_id::uuid END) AND b."ownerId"=$1
    LEFT JOIN agent_runs r ON r.id=(CASE WHEN page.run_id ~ ${UUID_TEXT} THEN page.run_id::uuid END) AND r."userId"=$1
    ORDER BY page.at DESC, page.id COLLATE "C" DESC`, [userId, query.after?.micros ?? null, query.after?.id ?? null, query.limit + 1])
  const more = rows.length > query.limit
  const page = more ? rows.slice(0, query.limit) : rows
  const last = page.at(-1)
  return {
    items: page.map(row => ({
      id: row.id, kind: row.kind, at: row.at.toISOString(),
      botId: uuidOrNull(row.bot_id), botName: row.bot_name ?? null,
      summary: row.summary,
      target: {
        runId: uuidOrNull(row.run_id), subagentId: uuidOrNull(row.subagent_id), issueId: row.issue_id ?? null,
        pendingActionId: row.pending_action_id, matterId: row.matter_id, url: row.url,
      },
      decidedBy: row.decided_by,
    })),
    nextCursor: more && last ? encodeActivityCursor({ micros: last.micros, id: last.id }) : null,
  }
}
