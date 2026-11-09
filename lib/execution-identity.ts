import type { Pool, PoolClient } from 'pg'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { WorkerDefinitionSnapshot } from './agent-kit/worker'
import { organizationResourceAllowed, assertOrganizationModelProvider } from './governance/resource-access'

/** Authority is host data, never a Decision/model argument. References only: no credentials. */
const resource = z.object({
  kind: z.enum(['device', 'api_key', 'subscription', 'e2b', 'mcp']), id: z.string().min(1), ownerId: z.string().min(1),
  access: z.enum(['owner', 'workspace_share']), revision: z.string().optional(),
  grantId: z.uuid().optional(), workspaceId: z.uuid().optional(),
})
const account = z.object({
  kind: z.enum(['api_key', 'subscription', 'native_login', 'local_device', 'e2b']),
  ownerId: z.string().min(1), resourceId: z.string().min(1),
  amount: z.enum(['provider_unknown', 'metered', 'not_applicable']),
})
export const executionIdentitySchema = z.object({
  version: z.literal(1), requester: z.string().min(1), botId: z.string().nullable(), botOwner: z.string().nullable(),
  executionPrincipal: z.string().min(1), workspaceId: z.string().nullable(), outputOwner: z.string().min(1),
  resourceBindings: z.array(resource), billingAccount: z.object({ model: account, runtime: account }),
  personalResourcePolicy: z.literal('requester_only'),
})
export type ExecutionIdentity = z.infer<typeof executionIdentitySchema>
type Query = Pick<Pool | PoolClient, 'query'>
type RunAuthority = { userId: string; botId: string | null; deviceId: string | null; agentDefinition: WorkerDefinitionSnapshot | null }

export class ExecutionIdentityError extends Error {
  constructor() { super('executionIdentityUnavailable'); this.name = 'ExecutionIdentityError' }
}
const denied = (): never => { throw new ExecutionIdentityError() }

/** Membership is in the workspace DB, not the application's DB. */
export async function executionMembersActive(workspaceId: string, users: string[], membership?: Query): Promise<boolean> {
  const query = membership ?? (await import('./workspace-db')).workspacePool
  const ids = [...new Set(users)]
  const { rows } = await query.query<{ userId: string }>(`SELECT "userId" FROM mikka_workspace_members
    WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status='active'`, [workspaceId, ids])
  return ids.every(id => rows.some(row => row.userId === id))
}

/** Used before selecting resources for a borrowed Bot. A Bot never lends its owner's computer or accounts. */
export async function executionBotScope(query: Query, requester: string, botId: string, membership?: Query) {
  const { rows: [bot] } = await query.query<{ ownerId: string | null; workspaceId: string }>('SELECT "ownerId","workspaceId" FROM bots WHERE id=$1 AND "archivedAt" IS NULL', [botId])
  if (!bot?.ownerId || !await executionMembersActive(bot.workspaceId, [requester, bot.ownerId], membership)) return denied()
  return { ownerId: bot.ownerId, workspaceId: bot.workspaceId }
}

/** Freeze only after the host selected a device/model and checked task access. Re-run at each authority boundary. */
export async function freezeExecutionIdentity(query: Query, run: RunAuthority, membership?: Query, workspaceHint?: string | null): Promise<ExecutionIdentity> {
  const definition = run.agentDefinition
  if (!definition || !run.deviceId) return denied()
  const bot = run.botId ? await executionBotScope(query, run.userId, run.botId, membership) : null
  const workspaceId = bot?.workspaceId ?? workspaceHint ?? null
  if (workspaceId && !bot && !await executionMembersActive(workspaceId, [run.userId], membership)) return denied()
  const { rows: [device] } = await query.query<{ ownerId: string; kind: string; enabled: boolean }>('SELECT "ownerId",kind,enabled FROM devices WHERE id=$1', [run.deviceId])
  if (!device?.enabled || device.ownerId !== run.userId) return denied()
  const resourceBindings: ExecutionIdentity['resourceBindings'] = [{ kind: 'device', id: run.deviceId, ownerId: device.ownerId, access: 'owner' }]
  if (definition.customMcp) {
    if (definition.customMcp.workspaceId !== workspaceId) return denied()
    const authority = await (await import('./plugins/workspace-mcp')).validateMcpAuthority(query, run.userId, definition.customMcp, membership).catch(() => denied())
    for (const grant of authority.servers) resourceBindings.push({ kind: 'mcp', id: grant.id, ownerId: grant.ownerId,
      access: grant.grantId ? 'workspace_share' : 'owner', revision: String(grant.revision),
      ...(grant.grantId ? { grantId: grant.grantId } : {}), ...(authority.workspaceId ? { workspaceId: authority.workspaceId } : {}),
    })
  }
  let model: ExecutionIdentity['billingAccount']['model'] = { kind: 'native_login', ownerId: run.userId, resourceId: run.deviceId, amount: 'provider_unknown' }
  if (definition.apiKey && definition.subscription) return denied()
  if (definition.apiKey) {
    if (workspaceId) await assertOrganizationModelProvider(workspaceId, 'api-key', membership)
    const { rows: [key] } = await query.query<{ ownerId: string; shared: boolean }>(`SELECT k."ownerId", EXISTS (
      SELECT 1 FROM model_api_key_shares s WHERE s."keyId"=k.id AND s."workspaceId"=$2
      AND NOT EXISTS (SELECT 1 FROM workspace_personal_policies p WHERE p."workspaceId"=$2 AND NOT p.subscriptions)) AS shared
      FROM model_api_keys k WHERE k.id=$1`, [definition.apiKey.keyId, workspaceId])
    if (!key || (key.ownerId !== run.userId && (!workspaceId || !key.shared || !await executionMembersActive(workspaceId, [run.userId, key.ownerId], membership)))) return denied()
    if (key.ownerId !== run.userId && !await organizationResourceAllowed(workspaceId!, 'api_key', definition.apiKey.keyId, key.ownerId, membership)) return denied()
    resourceBindings.push({ kind: 'api_key', id: definition.apiKey.keyId, ownerId: key.ownerId, access: key.ownerId === run.userId ? 'owner' : 'workspace_share' })
    model = { kind: 'api_key', ownerId: key.ownerId, resourceId: definition.apiKey.keyId, amount: 'provider_unknown' }
  } else if (definition.subscription) {
    const { rows: [binding] } = await query.query<{ ownerId: string; workspaceId: string; revision: string; modelId: string; route: string; shared: boolean }>(`SELECT b."ownerId",b."workspaceId",b."connectionRevision"::text AS revision,b."modelId",b.route,
      EXISTS (SELECT 1 FROM workspace_subscription_shares s WHERE s."ownerId"=b."ownerId" AND s."workspaceId"=$2 AND s."allowOthers"
      AND NOT EXISTS (SELECT 1 FROM workspace_personal_policies p WHERE p."workspaceId"=$2 AND NOT p.subscriptions)) AS shared
      FROM byos_bindings b JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId"
      AND c.state='connected' AND NOT c.paused AND c.epoch=b."connectionRevision" WHERE b.id=$1`, [definition.subscription.bindingId, workspaceId])
    if (!binding || binding.modelId !== definition.subscription.modelId || binding.route !== definition.subscription.route ||
      (binding.ownerId !== run.userId && (!workspaceId || binding.workspaceId !== workspaceId || !binding.shared || !await executionMembersActive(workspaceId, [run.userId, binding.ownerId], membership)))) return denied()
    if (binding.ownerId !== run.userId && !await organizationResourceAllowed(workspaceId!, 'subscription', binding.ownerId, binding.ownerId, membership)) return denied()
    resourceBindings.push({ kind: 'subscription', id: definition.subscription.bindingId, ownerId: binding.ownerId, access: binding.ownerId === run.userId ? 'owner' : 'workspace_share', revision: binding.revision })
    model = { kind: 'subscription', ownerId: binding.ownerId, resourceId: definition.subscription.bindingId, amount: 'provider_unknown' }
  } else if (device.kind === 'cloud') return denied()
  if (device.kind === 'cloud') {
    const { rows: [key] } = await query.query(`SELECT 1 FROM user_e2b_keys WHERE "userId"=$1 UNION ALL SELECT 1 FROM workspace_e2b_keys WHERE "createdBy"=$1 LIMIT 1`, [run.userId])
    if (!key) return denied()
    resourceBindings.push({ kind: 'e2b', id: run.userId, ownerId: run.userId, access: 'owner' })
  }
  return { version: 1, requester: run.userId, botId: run.botId, botOwner: bot?.ownerId ?? null,
    executionPrincipal: run.userId, workspaceId, outputOwner: run.userId, resourceBindings,
    billingAccount: { model, runtime: { kind: device.kind === 'cloud' ? 'e2b' : 'local_device', ownerId: device.ownerId, resourceId: device.kind === 'cloud' ? run.userId : run.deviceId, amount: device.kind === 'cloud' ? 'provider_unknown' : 'not_applicable' } },
    personalResourcePolicy: 'requester_only' }
}

/** Existing historical runs stay explicitly unattributed; they gain no new sharing authority. */
export async function revalidateExecutionIdentity(query: Query, run: RunAuthority, membership?: Query): Promise<ExecutionIdentity | null> {
  const frozen = run.agentDefinition?.executionIdentity
  if (frozen === undefined) return null
  const parsed = executionIdentitySchema.safeParse(frozen)
  if (!parsed.success) return denied()
  const current = await freezeExecutionIdentity(query, run, membership, parsed.data.workspaceId)
  if (!isDeepStrictEqual(parsed.data, current)) return denied()
  return parsed.data
}

export async function executionIdentityForRun(query: Query, runId: string, userId?: string, membership?: Query): Promise<ExecutionIdentity | null> {
  const { rows: [run] } = await query.query<RunAuthority>('SELECT "userId","botId","deviceId","agentDefinition" FROM agent_runs WHERE id=$1', [runId])
  if (!run || (userId && run.userId !== userId)) return denied()
  return revalidateExecutionIdentity(query, run, membership)
}

/** Only the host's device handoff path calls this, after choosing another device owned by the same requester.
 * A dead source device need not be online. All non-device grants are checked again and retain their original identity. */
export async function rebindExecutionDevice(query: Query, run: RunAuthority, deviceId: string, membership?: Query): Promise<WorkerDefinitionSnapshot | null> {
  if (!run.agentDefinition?.executionIdentity) return run.agentDefinition
  const prior = executionIdentitySchema.parse(run.agentDefinition.executionIdentity)
  const next = await freezeExecutionIdentity(query, { ...run, deviceId }, membership, prior.workspaceId)
  const standing = (identity: ExecutionIdentity) => ({ requester: identity.requester, botId: identity.botId, botOwner: identity.botOwner,
    executionPrincipal: identity.executionPrincipal, workspaceId: identity.workspaceId, outputOwner: identity.outputOwner,
    resourceBindings: identity.resourceBindings.filter(binding => binding.kind !== 'device' && binding.kind !== 'e2b'),
    model: identity.billingAccount.model.kind === 'native_login' ? { ...identity.billingAccount.model, resourceId: null } : identity.billingAccount.model, runtimeOwner: identity.billingAccount.runtime.ownerId, personalResourcePolicy: identity.personalResourcePolicy })
  if (!isDeepStrictEqual(standing(prior), standing(next))) return denied()
  return { ...run.agentDefinition, executionIdentity: next }
}

/** The last authorization point before a provider call, after discovery/decision IO. */
export async function activeExecutionIdentity(query: Query, runId: string, userId: string, membership?: Query): Promise<ExecutionIdentity | null> {
  const { rows: [run] } = await query.query<RunAuthority & { status: string; stopRequestedAt: Date | null; leaseExpiresAt: Date | null }>(
    'SELECT "userId","botId","deviceId","agentDefinition",status,"stopRequestedAt","leaseExpiresAt" FROM agent_runs WHERE id=$1', [runId])
  if (!run || run.userId !== userId || run.stopRequestedAt || !['queued', 'preparing', 'running', 'waiting_input', 'finishing'].includes(run.status)) return denied()
  if (run.deviceId && run.status !== 'queued' && (!run.leaseExpiresAt || new Date(run.leaseExpiresAt).getTime() <= Date.now())) return denied()
  return revalidateExecutionIdentity(query, run, membership)
}
