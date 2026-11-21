import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { digest } from '@/lib/agent-kit/definition'
import { bindAgentToConnection, resolveModelDispatch, type ModelDispatch } from '@/lib/model-dispatch'
import { credentialStates, orderCandidates, selectedOrderCandidates, readOrder, poolDevices } from '@/lib/model-order'
import { entryKey, planDispatch, sourceId as entrySourceId, type OrderEntry, type OrderHarness, type RunLocation } from '@/lib/model-order-plan'
import { cloudModelSupport } from '@/lib/cloud-template-models'
import { cloudReady } from '@/lib/rule-dispatch'
import { BUILTIN_AGENT_PROFILE_ID, BUILTIN_AGENT_PROFILE_VERSION, builtinAgentProfileDefinition, builtinAgentProfileSelection, profileFixedModel, profileHarness, AgentProfileError, agentProfileDigest, agentProfileInstructions, agentProfileLegacyInstructions, parseAgentProfile, type AgentProfileScope, type AgentProfileSelection } from './agent-profile-definition'
import { acquireProfileMembership, profileView, readProfileRow, readProfileRows, validateProfileScope, type ProfileMembership, type ProfileQuery, type ProfileRow } from './agent-profile-store'
import { agentProfileSkillAvailability, agentProfileSkillCatalog, agentProfileSkillSource } from './agent-profile-skills'
import { resolveProfileMark, type ProfileMarkValue } from './agent-profile-mark'
import type { PublicAgentProfile } from './agent-profile-decision'

export * from './agent-profile-definition'
export { AgentProfileStore } from './agent-profile-store'
export type { PublicAgentProfile } from './agent-profile-decision'
export interface AgentProfileDispatchRequest {
  issueId: string
  stage?: string
  note?: string
  profileId?: string
  asked?: { harness: OrderHarness; model?: string } | null
  location?: RunLocation
  deviceId?: string
  agentId?: string
  withoutCloud?: boolean
  cloudPurpose?: import('../cloud-template-models').CloudModelPurpose
  /** Only the legacy path uses this; real profile candidates can cross harnesses. */
  defaultHarness?: OrderHarness
  /** Host-only continuation of a default/legacy thread; never reselect its role. */
  defaultOnly?: boolean
}
export interface AgentProfileDispatchResult {
  target: ModelDispatch
  agentProfile?: AgentProfileSelection
  selectionMode?: 'picked' | 'preference'
}
type DispatchScope = AgentProfileScope & { botId: string | null }
type DispatchDependencies = {
  /** Host-owned Factory client; its real COMMIT acquires the final lease. */
  transaction?: PoolClient
  membership?: (scope: AgentProfileScope) => Promise<ProfileMembership>
  resolve?: typeof resolveModelDispatch
}
const requestConstraints = async (pool: Pool, scope: AgentProfileScope, request: Partial<AgentProfileDispatchRequest>) => {
  let harness = request.asked?.harness, deviceId = request.deviceId
  if (request.agentId) {
    z.uuid().parse(request.agentId)
    const { rows: [agent] } = await pool.query<{ harness: OrderHarness; deviceId: string | null }>('SELECT harness,"deviceId" FROM agents WHERE id=$1 AND "userId"=$2', [request.agentId, scope.ownerId])
    if (!agent || !agent.deviceId) throw new AgentProfileError('agentProfileUnavailable')
    if ((harness && harness !== agent.harness) || (deviceId && deviceId !== agent.deviceId)) throw new AgentProfileError('agentProfilePinConflict')
    harness = agent.harness; deviceId = agent.deviceId
  }
  return { harness, deviceId }
}
type Eligible = { row: ProfileRow; public: PublicAgentProfile }
function publicProfile(row: ProfileRow, skills: ProfileRow['skills']): PublicAgentProfile {
  return {
    id: row.id, name: row.definition.name, description: row.definition.description,
    // Only trusted, bounded metadata enters model context: never a body,
    // private path or source revision.
    skills: skills.slice(0, 12).map(skill => ({ id: skill.id, name: skill.name, description: skill.description.slice(0, 200), source: agentProfileSkillSource(skill.id) })),
  }
}
const SKILL_REASONS = { missing: 'skillMissing', disabled: 'skillDisabled', forbidden: 'skillForbidden', invalid: 'skillsChanged' } as const
/** A Profile is content only (decision 2026-11-15-1630): it is usable when it
 * is enabled and its pinned Skills are still authorized. Where it runs and on
 * which model come from the task, never from the Profile. */
async function eligibleProfiles(pool: ProfileQuery, scope: AgentProfileScope, rows: ProfileRow[]) {
  const eligible: Eligible[] = [], availability: Record<string, { available: boolean; reason?: string }> = {}
  for (const row of rows) {
    const definition = parseAgentProfile(row.definition)
    if (!definition.enabled || row.archivedAt) { availability[row.id] = { available: false, reason: row.archivedAt ? 'archived' : 'disabled' }; continue }
    // The stored envelope is the pinned version; the current source only has
    // to remain authorized. A text change never rewrites a saved Profile.
    const skills = row.skills
    if (!Array.isArray(skills) || agentProfileDigest(definition, skills) !== row.digest) { availability[row.id] = { available: false, reason: 'skillsChanged' }; continue }
    const states = await agentProfileSkillAvailability(pool, scope, skills)
    const unavailable = Object.values(states).find(state => !state.available)
    if (unavailable) { availability[row.id] = { available: false, reason: SKILL_REASONS[unavailable.reason ?? 'missing'] }; continue }
    availability[row.id] = { available: true }
    eligible.push({ row, public: publicProfile(row, skills) })
  }
  return { eligible, availability }
}

/** Only the actor's authorized, currently runnable public summaries enter model context.
 * The mark rides along here so a reply can name a Profile as the UI draws it; the Decision input stays without it. */
export async function listPublicAgentProfiles(pool: Pool, scope: DispatchScope): Promise<(PublicAgentProfile & ProfileMarkValue)[]> {
  const member = await acquireProfileMembership(scope)
  try { return (await eligibleProfiles(pool, scope, await readProfileRows(pool, scope))).eligible.map(item => ({ ...item.public, ...resolveProfileMark(item.public, item.row) })) }
  finally { await member.close() }
}

/** Read-only availability without selecting a role or binding a source. Group
 * intents alone may defer a positive-but-stale official quota to real dispatch;
 * previews and every admission/claim keep the strict current-allowance gate. */
export async function agentProfileDispatchAvailability(pool: Pool, scope: DispatchScope, request: Partial<AgentProfileDispatchRequest> = {}, options: { deferStaleQuota?: true } = {}): Promise<{ available: boolean; reason?: string }> {
  validateProfileScope(scope)
  const member = await acquireProfileMembership(scope)
  try {
    const rows = await readProfileRows(pool, scope)
    const explicit = request.profileId && request.profileId !== BUILTIN_AGENT_PROFILE_ID ? rows.find(row => row.id === request.profileId) : undefined
    if (request.profileId && request.profileId !== BUILTIN_AGENT_PROFILE_ID && !explicit) return { available: false, reason: 'agentProfileNotFound' }
    if (explicit && !explicit.definition.enabled) return { available: false, reason: 'agentProfileDisabled' }
    if (explicit) {
      const { eligible, availability } = await eligibleProfiles(pool, scope, [explicit])
      if (!eligible.length) { await member.check(); return { available: false, reason: availability[explicit.id]?.reason ?? 'agentProfileUnavailable' } }
    }
    const constraints = await requestConstraints(pool, scope, request)
    const target = await resolveModelDispatch(pool, scope, request.asked?.model ? request.asked : undefined, request.location, constraints.deviceId, { harness: constraints.harness ?? request.defaultHarness, cloudPurpose: request.cloudPurpose, withoutCloud: request.withoutCloud, agentId: request.agentId, skipCatalogueRefresh: true, probeQuota: false, bindSubscription: false, ...(options.deferStaleQuota ? { deferStaleQuota: true } : {}) })
    await member.check()
    return target.kind === 'none' ? { available: false, reason: target.reason } : { available: true, ...(target.quotaCheckPending ? { reason: 'quota_check_required' } : {}) }
  } finally { await member.close() }
}

/** Settings projection: no provider probes, secret reads, or subscription binding writes. */
export async function agentProfileCatalog(pool: Pool, scope: AgentProfileScope) {
  const candidates = await orderCandidates(pool, scope)
  const order = await readOrder(pool, scope, candidates)
  const entries: OrderEntry[] = candidates.map(candidate => ({ id: `profile-catalog:${encodeURIComponent(entryKey(candidate))}`, harness: candidate.harness, model: candidate.model, source: candidate.source }))
  const [states, devices, connectedAgents, claudeReady, codexReady, labels, skills] = await Promise.all([
    credentialStates(pool, scope, entries, candidates, undefined, { probe: false }), poolDevices(pool, scope.ownerId),
    pool.query<{ deviceId: string; harness: string }>('SELECT DISTINCT "deviceId",harness FROM agents WHERE "userId"=$1 AND "deviceId" IS NOT NULL', [scope.ownerId]),
    cloudReady(pool, { ...scope, botId: null, harness: 'claude_code' }), cloudReady(pool, { ...scope, botId: null, harness: 'codex' }),
    pool.query<{ id: string; label: string | null }>('SELECT id::text AS id,"accountLabel" AS label FROM byos_connections WHERE "ownerId"=$1 UNION ALL SELECT id::text AS id,name AS label FROM model_api_keys WHERE "ownerId"=$1', [scope.ownerId]),
    agentProfileSkillCatalog(pool, scope),
  ])
  const models = entries.map((entry, index) => {
    const compatible = devices.filter(device => connectedAgents.rows.some(agent => agent.deviceId === device.id && agent.harness === entry.harness))
    const plan = planDispatch({ entries: [], explicit: entry, location: order.location, devices: compatible, credential: item => states.get(item.id)?.credential ?? { usable: false, reason: 'missing' }, cloudReady: entry.harness === 'codex' ? codexReady : claudeReady, cloudModel: item => cloudModelSupport(item) })
    const sourceId = entrySourceId(entry.source)
    const sourceLabel = labels.rows.find(label => label.id === sourceId)?.label || undefined
    const sourceIds = [...new Set(entries.filter(item => item.source.kind === entry.source.kind).map(item => entrySourceId(item.source)))]
    const sourceOrdinal = sourceIds.indexOf(sourceId) + 1
    return { harness: entry.harness, model: entry.model, source: entry.source, provider: candidates[index].provider, ...(sourceLabel ? { sourceLabel } : {}), sourceOrdinal, available: plan.kind !== 'none', ...(plan.kind === 'none' ? { reason: plan.reason } : {}) }
  })
  return { models, skills }
}
export async function readAgentProfileManagement(pool: Pool, scope: AgentProfileScope, preview: Pick<AgentProfileDispatchRequest, 'location' | 'deviceId'> = {}) {
  const member = await acquireProfileMembership(scope)
  try {
    const rows = await readProfileRows(pool, scope)
    const [catalog, { availability }, fallback] = await Promise.all([agentProfileCatalog(pool, scope), eligibleProfiles(pool, scope, rows), resolveModelDispatch(pool, { ...scope, botId: null }, undefined, preview.location, preview.deviceId, { skipCatalogueRefresh: true, probeQuota: false, bindSubscription: false })])
    await member.check()
    return { profiles: rows.map(profileView), catalog, availability, defaultAvailability: fallback.kind === 'none' ? { available: false, reason: fallback.reason } : { available: true } }
  } finally { await member.close() }
}

/** Dispatch and first claim call this inside the authoritative transaction.
 * Existing native sessions are exempted only by the caller's verified DB ancestry. */
export async function assertProfileSelection(query: ProfileQuery, scope: AgentProfileScope, selection: AgentProfileSelection): Promise<void> {
  validateProfileScope(scope)
  if (!selection || selection.scope?.ownerId !== scope.ownerId || selection.scope?.workspaceId !== scope.workspaceId) throw new AgentProfileError('agentProfileScopeNotFound', 404)
  let definition: AgentProfileSelection['definition'], skills: AgentProfileSelection['skills']
  if (selection.profileId === BUILTIN_AGENT_PROFILE_ID) {
    definition = builtinAgentProfileDefinition(); skills = []
    if (selection.source !== 'default' || selection.version !== BUILTIN_AGENT_PROFILE_VERSION || selection.digest !== agentProfileDigest(definition, skills) || selection.decision) throw new AgentProfileError('agentProfileSelectionInvalid')
  } else {
    if (selection.source !== 'explicit' && selection.source !== 'decision') throw new AgentProfileError('agentProfileSelectionInvalid')
    const row = await readProfileRow(query, scope, selection.profileId, 'share')
    if (row.archivedAt) throw new AgentProfileError('agentProfileArchived')
    if (!row.definition.enabled) throw new AgentProfileError('agentProfileDisabled')
    if (row.version !== selection.version || row.digest !== selection.digest) throw new AgentProfileError('agentProfileVersionConflict')
    definition = parseAgentProfile(row.definition); skills = row.skills
    // A pinned body stays valid, but a source that was disabled, unshared or
    // removed between dispatch and claim cannot silently keep running.
    const states = await agentProfileSkillAvailability(query, scope, skills)
    const unavailable = Object.entries(states).find(([, state]) => !state.available)
    if (unavailable) throw new AgentProfileError('agentProfileSkillUnavailable', 409, { detail: unavailable[1].reason })
  }
  if (agentProfileDigest(definition, skills) !== selection.digest || digest(definition) !== digest(selection.definition) || digest(skills) !== digest(selection.skills) || (selection.instructions !== agentProfileInstructions(definition, skills) && selection.instructions !== agentProfileLegacyInstructions(definition, skills)) || selection.effort !== (selection.contentOnly ? undefined : definition.effort) || selection.name !== definition.name) throw new AgentProfileError('agentProfileSelectionInvalid')
  await assertProfileTarget(query, scope, selection)
}

/** Recheck only the current target after a host receipt has independently
 * established the frozen role. This never grants permission to use a Profile. */
export async function assertProfileTarget(query: ProfileQuery, scope: AgentProfileScope, selection: AgentProfileSelection): Promise<void> {
  validateProfileScope(scope)
  if (selection.scope?.ownerId !== scope.ownerId || selection.scope?.workspaceId !== scope.workspaceId) throw new AgentProfileError('agentProfileScopeNotFound', 404)
  // Content-only selections pin nothing; an older frozen selection keeps the
  // harness and model fence it was admitted with.
  const entry = selection.targetEntry, harness = profileHarness(selection), fixed = profileFixedModel(selection)
  if (!entry || (harness && harness !== entry.harness) || (fixed && entryKey(fixed) !== entryKey(entry))) throw new AgentProfileError('agentProfilePinConflict')
  if (selection.profileId !== BUILTIN_AGENT_PROFILE_ID && (selection.source === 'explicit' || selection.source === 'decision') && fixed) {
    await assertFrozenModelCandidates(query, scope, entry, await selectedOrderCandidates(query, scope, entry))
  } else await assertFrozenModelTarget(query, scope, entry)
}

/** The same source fence also serves historical runs that predate Profiles.
 * This validates one frozen entry; it never selects another role or model. */
export async function assertFrozenModelTarget(query: ProfileQuery, scope: AgentProfileScope, entry: OrderEntry): Promise<void> {
  validateProfileScope(scope)
  await assertFrozenModelCandidates(query, scope, entry, await orderCandidates(query, scope))
}

async function assertFrozenModelCandidates(query: ProfileQuery, scope: AgentProfileScope, entry: OrderEntry, candidates: Awaited<ReturnType<typeof orderCandidates>>): Promise<void> {
  // Mikka 额度 is no connected credential: any catalogue model may run, and the
  // model gateway charges or refuses each request (decision 2026-11-15-2000).
  if (entry.source.kind === 'credits') {
    if (!(await import('@/lib/model-catalog')).isCatalogId(entry.model)) throw new AgentProfileError('agentProfileModelUnavailable')
    return
  }
  if (!candidates.some(candidate => entryKey(candidate) === entryKey(entry))) throw new AgentProfileError('agentProfileModelUnavailable')
  // Pin the source's current authorization row against a concurrent disconnect/delete.
  if (entry.source.kind === 'subscription') await query.query('SELECT id FROM byos_connections WHERE id=$1 FOR SHARE', [entry.source.connectionId])
  else await query.query('SELECT id FROM model_api_keys WHERE id=$1 FOR SHARE', [entry.source.keyId])
  const state = (await credentialStates(query, scope, [entry], candidates, undefined, { probe: false })).get(entry.id)
  if (!state?.credential.usable) {
    const details = { checking: 'checking', quota: 'quota', expired: 'expired', paused: 'paused', missing: 'missing', removed: 'removed', modelGone: 'model_gone', keyRefused: 'key_refused', balance: 'balance', providerUnavailable: 'provider_unavailable' } as const
    const credential = state?.credential
    throw new AgentProfileError('agentProfileModelUnavailable', 409, { detail: credential?.usable === false ? details[credential.reason] : 'missing' })
  }
}

export async function resolveAgentProfileDispatch(pool: Pool, scope: DispatchScope, request: AgentProfileDispatchRequest, deps: DispatchDependencies = {}): Promise<AgentProfileDispatchResult> {
  validateProfileScope(scope)
  if (deps.transaction) (await import('./transaction')).assertFactoryTransaction(deps.transaction)
  const membership = deps.membership ?? acquireProfileMembership
  const initialMember = await membership(scope)
  let rows: ProfileRow[]
  try { rows = await readProfileRows(pool, scope); await initialMember.check() }
  finally { await initialMember.close() }
  // Catalogue/credential refresh and model routing can outlive the 20-second
  // membership lease. Plan without holding that lease or writing a binding,
  // then acquire current authority again for the short admission transaction.
  const finalize = async (target: ModelDispatch, agentProfile: AgentProfileSelection | undefined, selectionMode: 'picked' | 'preference'): Promise<AgentProfileDispatchResult> => {
    const client = deps.transaction ?? await pool.connect()
    let member: ProfileMembership | undefined
    try {
      if (!deps.transaction) await client.query('BEGIN')
      if (agentProfile) await assertProfileTarget(client, scope, agentProfile)
      if (target.kind === 'device' && target.entry.source.kind === 'subscription') target = { ...target, subscriptionBindingId: await bindAgentToConnection(client, scope, target.agentId, target.entry.harness, target.entry.source.connectionId, target.entry.model) }
      // Finish shared-source authorization before taking the Profile lock.
      // Binding effects remain uncommitted until the current Profile and
      // fresh membership checks both pass.
      if (agentProfile) await assertProfileSelection(client, scope, agentProfile)
      if (deps.transaction) (await import('./transaction')).registerFactoryProfile(client, scope, agentProfile)
      else {
        member = await membership(scope)
        await member.check(client)
        await client.query('COMMIT')
      }
      return { target, ...(agentProfile ? { agentProfile } : {}), selectionMode }
    } catch (error) { if (!deps.transaction) await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { if (!deps.transaction) { await member?.close(); client.release() } }
  }
  // The model and machine come from the task, never from the Profile.
  const resolveTarget = async () => {
    const constraints = await requestConstraints(pool, scope, request)
    // Every task dispatch names its Agent (decision 2026-11-17-1800); its entry
    // points refuse one without (agentRequired) before reaching this resolver.
    return (deps.resolve ?? resolveModelDispatch)(pool, scope, request.asked?.model ? request.asked : undefined, request.location, constraints.deviceId, { withoutCloud: request.withoutCloud, cloudPurpose: request.cloudPurpose, harness: constraints.harness ?? request.defaultHarness, agentId: request.agentId, bindSubscription: false })
  }
  const selectionMode = request.asked?.model ? 'picked' as const : 'preference' as const
  if (request.defaultOnly && request.profileId && request.profileId !== BUILTIN_AGENT_PROFILE_ID) throw new AgentProfileError('agentProfilePinConflict')
  // A Profile is used only when someone names it: a person in the task form,
  // or the Coordinator by id. Nothing chooses one automatically.
  if (request.defaultOnly || !request.profileId || request.profileId === BUILTIN_AGENT_PROFILE_ID) {
    const target = await resolveTarget()
    return finalize(target, target.kind === 'none' ? undefined : builtinAgentProfileSelection(scope, target.entry), selectionMode)
  }
  const row = rows.find(item => item.id === request.profileId)
  if (!row) throw new AgentProfileError('agentProfileNotFound', 404)
  if (!row.definition.enabled) throw new AgentProfileError('agentProfileDisabled')
  if (!(await eligibleProfiles(pool, scope, [row])).eligible.length) throw new AgentProfileError('agentProfileUnavailable')
  const target = await resolveTarget()
  if (target.kind === 'none') throw new AgentProfileError('agentProfileModelUnavailable')
  // The stored envelope is the exact pinned version; `eligibleProfiles` has
  // already rechecked that its sources remain authorized.
  const definition = parseAgentProfile(row.definition), skills = row.skills
  const selection: AgentProfileSelection = {
    profileId: row.id, version: row.version, digest: row.digest, name: definition.name,
    source: 'explicit', reason: 'explicit', scope: { ownerId: scope.ownerId, workspaceId: scope.workspaceId }, definition, skills,
    instructions: agentProfileInstructions(definition, skills), targetEntry: target.entry, contentOnly: true,
  }
  return finalize(target, selection, selectionMode)
}
