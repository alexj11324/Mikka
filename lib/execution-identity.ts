import type { Pool, PoolClient } from 'pg'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { WorkerDefinitionSnapshot } from './agent-kit/worker'
import { organizationResourceAllowed, assertOrganizationModelProvider } from './governance/resource-access'
import { organizationConnectionAuthority, workspaceModelPolicy } from './organization-connections-access'
import { organizationCredentialOwner, organizationModelAllowed } from './organization-model-policy'

/** Authority is host data, never a Decision/model argument. References only: no credentials. */
const resource = z.object({
  kind: z.enum(['device', 'api_key', 'subscription', 'e2b', 'mcp']), id: z.string().min(1), ownerId: z.string().min(1),
  access: z.enum(['owner', 'workspace_share', 'organization']), revision: z.string().optional(),
  grantId: z.uuid().optional(), workspaceId: z.uuid().optional(), organizationId: z.uuid().optional(),
})
const account = z.object({
  kind: z.enum(['api_key', 'subscription', 'native_login', 'local_device', 'e2b']),
  ownerId: z.string().min(1), resourceId: z.string().min(1),
  amount: z.enum(['provider_unknown', 'metered', 'not_applicable']),
  organizationId: z.uuid().optional(),
})
const payer = z.object({ kind: z.enum(['personal', 'organization']), id: z.string().min(1) })
export const executionIdentitySchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), requester: z.string().min(1), botId: z.string().nullable(), botOwner: z.string().nullable(),
  actor: z.string().min(1).optional(), threadOwner: z.string().min(1).optional(), credentialOwner: z.string().min(1).optional(),
  collaborationAuthorizationId: z.uuid().optional(),
  modelPayer: payer.optional(), computePayer: payer.optional(), modelSelection: z.object({ harness: z.string().min(1), model: z.string().nullable() }).optional(),
  executionPrincipal: z.string().min(1), workspaceId: z.string().nullable(), outputOwner: z.string().min(1),
  resourceBindings: z.array(resource), billingAccount: z.object({ model: account, runtime: account }),
  personalResourcePolicy: z.literal('requester_only'),
}).superRefine((identity, ctx) => {
  if (identity.version === 2 && (!identity.actor || !identity.threadOwner || !identity.credentialOwner || !identity.modelPayer || !identity.computePayer || !identity.modelSelection)) ctx.addIssue({ code: 'custom', message: 'execution_identity_principals_required' })
})
export type ExecutionIdentity = z.infer<typeof executionIdentitySchema>
type Query = Pick<Pool | PoolClient, 'query'>
export type RunAuthority = { userId: string; botId: string | null; deviceId: string | null; agentDefinition: WorkerDefinitionSnapshot | null; actorId?: string; threadOwnerId?: string; collaborationAuthorizationId?: string }

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
  const prior = definition.executionIdentity
  const actor = run.actorId ?? prior?.actor ?? run.userId
  const threadOwner = run.threadOwnerId ?? prior?.threadOwner ?? run.userId
  const collaborationAuthorizationId = run.collaborationAuthorizationId ?? prior?.collaborationAuthorizationId
  const collaborating = actor !== run.userId
  // An ACL edit grant alone never lends the execution owner's resources.
  if (collaborating && (!collaborationAuthorizationId || !definition.apiKey || definition.subscription)) return denied()
  const historical = prior?.version === 1
  const bot = run.botId ? await executionBotScope(query, run.userId, run.botId, membership) : null
  const workspaceId = bot?.workspaceId ?? workspaceHint ?? null
  if (workspaceId && !bot && !await executionMembersActive(workspaceId, [run.userId], membership)) return denied()
  if (collaborating && (!workspaceId || !await executionMembersActive(workspaceId, [actor, run.userId], membership))) return denied()
  const { rows: [device] } = await query.query<{ ownerId: string; kind: string; enabled: boolean }>('SELECT "ownerId",kind,enabled FROM devices WHERE id=$1', [run.deviceId])
  if (!device?.enabled || device.ownerId !== run.userId) return denied()
  if (collaborating && device.kind !== 'cloud') return denied()
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
    const { rows: [key] } = await query.query<{ ownerId: string; shared: boolean; ownership: string | null; organizationId: string | null; revision: string | null; models: string[]; modelSettings: unknown }>(`SELECT k."ownerId",to_jsonb(k)->>'ownership' AS ownership,to_jsonb(k)->>'organizationId' AS "organizationId",to_jsonb(k)->>'revision' AS revision,k.models,to_jsonb(k)->'modelSettings' AS "modelSettings", EXISTS (
      SELECT 1 FROM model_api_key_shares s WHERE s."keyId"=k.id AND s."workspaceId"=$2
      AND NOT EXISTS (SELECT 1 FROM workspace_personal_policies p WHERE p."workspaceId"=$2 AND NOT p.subscriptions)) AS shared
      FROM model_api_keys k WHERE k.id=$1 AND to_jsonb(k)->>'revokedAt' IS NULL`, [definition.apiKey.keyId, workspaceId])
    if (!key) return denied()
    const organization = key.ownership === 'organization'
    if (organization) {
      const authority = workspaceId && await organizationConnectionAuthority(workspaceId, actor, membership)
      if (!authority || authority.organizationId !== key.organizationId || key.ownerId !== organizationCredentialOwner(authority.organizationId)) return denied()
      if (collaborating && (await organizationConnectionAuthority(workspaceId!, run.userId, membership))?.organizationId !== authority.organizationId) return denied()
    } else {
      if (key.ownerId !== actor && (!workspaceId || !key.shared || !await executionMembersActive(workspaceId, [actor, key.ownerId], membership))) return denied()
      if (key.ownerId !== actor && !await organizationResourceAllowed(workspaceId!, 'api_key', definition.apiKey.keyId, key.ownerId, membership)) return denied()
    }
    if (workspaceId && !organizationModelAllowed(await workspaceModelPolicy(workspaceId, membership), definition.apiKey.model,
      organization ? 'organization' : key.ownerId === actor ? 'personal_api_key' : 'shared_api_key', definition.apiKey.keyId)) return denied()
    // Catalogue removal and a newly disabled model must take effect at claim/renewal too.
    if (key.models && (!key.models.includes(definition.apiKey.model) || !(await import('./enabled-models-policy')).modelEnabled(key.modelSettings as import('./enabled-models-policy').ModelSettings | null, definition.apiKey.model))) return denied()
    resourceBindings.push({ kind: 'api_key', id: definition.apiKey.keyId, ownerId: key.ownerId, access: organization ? 'organization' : key.ownerId === actor ? 'owner' : 'workspace_share',
      ...(!historical && key.revision ? { revision: key.revision } : {}), ...(organization ? { organizationId: key.organizationId! } : {}) })
    model = { kind: 'api_key', ownerId: key.ownerId, resourceId: definition.apiKey.keyId, amount: 'provider_unknown', ...(organization ? { organizationId: key.organizationId! } : {}) }
  } else if (definition.subscription) {
    const { rows: [binding] } = await query.query<{ ownerId: string; workspaceId: string; revision: string; modelId: string; route: string }>(`SELECT b."ownerId",b."workspaceId",b."connectionRevision"::text AS revision,b."modelId",b.route
      FROM byos_bindings b JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId"
      AND c.state='connected' AND NOT c.paused AND c.epoch=b."connectionRevision" WHERE b.id=$1`, [definition.subscription.bindingId])
    if (!binding || binding.ownerId !== run.userId || binding.modelId !== definition.subscription.modelId || binding.route !== definition.subscription.route) return denied()
    if (workspaceId && !organizationModelAllowed(await workspaceModelPolicy(workspaceId, membership), binding.modelId, 'personal_subscription')) return denied()
    resourceBindings.push({ kind: 'subscription', id: definition.subscription.bindingId, ownerId: binding.ownerId, access: 'owner', revision: binding.revision })
    model = { kind: 'subscription', ownerId: binding.ownerId, resourceId: definition.subscription.bindingId, amount: 'provider_unknown' }
  } else if (device.kind === 'cloud') return denied()
  if (device.kind === 'cloud') {
    const { rows: [key] } = await query.query(`SELECT 1 FROM user_e2b_keys WHERE "userId"=$1 UNION ALL SELECT 1 FROM workspace_e2b_keys WHERE "createdBy"=$1 LIMIT 1`, [run.userId])
    if (!key) return denied()
    resourceBindings.push({ kind: 'e2b', id: run.userId, ownerId: run.userId, access: 'owner' })
  }
  if (collaborating) {
    const { validateCollaborationRunAuthority } = await import('./collaboration-run-authority')
    if (!await validateCollaborationRunAuthority(query, { authorizationId: collaborationAuthorizationId!, actorId: actor,
      executionOwnerId: run.userId, threadOwnerId: threadOwner, workspaceId: workspaceId!, deviceId: run.deviceId,
      credentialKind: 'api_key', credentialOwnerId: model.ownerId, credentialId: model.resourceId,
      model: definition.apiKey!.model, harness: definition.harness })) return denied()
  }
  return { version: historical ? 1 : 2, requester: historical ? run.userId : actor, botId: run.botId, botOwner: bot?.ownerId ?? null,
    ...(!historical ? { actor, threadOwner, credentialOwner: model.ownerId,
      modelPayer: { kind: model.organizationId ? 'organization' as const : 'personal' as const, id: model.organizationId ?? model.ownerId },
      computePayer: { kind: 'personal' as const, id: device.ownerId }, modelSelection: { harness: definition.harness, model: definition.apiKey?.model ?? definition.subscription?.modelId ?? definition.model ?? null } } : {}),
    ...(collaborationAuthorizationId ? { collaborationAuthorizationId } : {}),
    executionPrincipal: run.userId, workspaceId, outputOwner: historical ? run.userId : threadOwner, resourceBindings,
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
    actor: identity.actor, threadOwner: identity.threadOwner, collaborationAuthorizationId: identity.collaborationAuthorizationId, credentialOwner: identity.credentialOwner, modelPayer: identity.modelPayer, computePayer: identity.computePayer, modelSelection: identity.modelSelection,
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
