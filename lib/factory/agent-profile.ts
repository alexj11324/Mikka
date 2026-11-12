import 'server-only'
import { logCodedError } from '@mikka/protocol/coded-error'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { digest } from '@/lib/agent-kit/definition'
import { bindAgentToConnection, resolveModelDispatch, type ModelDispatch } from '@/lib/model-dispatch'
import { credentialStates, orderCandidates, selectedOrderCandidates, readOrder, poolDevices } from '@/lib/model-order'
import { entryKey, planDispatch, type OrderEntry, type OrderHarness, type RunLocation } from '@/lib/model-order-plan'
import { cloudModelSupport } from '@/lib/cloud-template-models'
import { cloudReady } from '@/lib/rule-dispatch'
import { hostedBillingScope } from '@/lib/abuse/context'
import { invokeDecision } from '@/lib/coordinator/decide'
import { BUILTIN_AGENT_PROFILE_ID, BUILTIN_AGENT_PROFILE_VERSION, builtinAgentProfileDefinition, builtinAgentProfileSelection, AgentProfileError, agentProfileDigest, agentProfileInstructions, agentProfileLegacyInstructions, parseAgentProfile, type AgentProfileScope, type AgentProfileSelection } from './agent-profile-definition'
import { acquireProfileMembership, profileView, readProfileRow, readProfileRows, validateProfileScope, type ProfileMembership, type ProfileQuery, type ProfileRow } from './agent-profile-store'
import { agentProfileSkillAvailability, agentProfileSkillCatalog, agentProfileSkillSource } from './agent-profile-skills'
import { maskFactoryNote } from './note-mask'
import { resolveProfileMark, type ProfileMarkValue } from './agent-profile-mark'
import { profileDecisionDiagnostics, profileDecisionInput, profileDecisionQuestions, profileDecisionSelection, type ProfileCheckWork, type PublicAgentProfile } from './agent-profile-decision'
import type { ModelRoutingContext } from '@/lib/model-routing-server'

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
  /** Existing retry/repair host context; never a client-supplied model choice. */
  routing?: Pick<ModelRoutingContext, 'previous' | 'escalate'>
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
  /** Host projection of the current independent check, not request JSON. */
  checkWork?: ProfileCheckWork
  membership?: (scope: AgentProfileScope) => Promise<ProfileMembership>
  resolve?: typeof resolveModelDispatch
  decision?: typeof invokeDecision
  modelDecision?: typeof invokeDecision
  /** Host-only work from the locked Factory task, never a client choice or
   * an execution grant. Read its Owner context only when a Decision is needed. */
  independentCheck?: () => Promise<{
    taskId: string
    requestEpoch: string
    candidateId: string
    stage: 'review' | 'verify'
    currentOwnerRequest: string
  }>
}
type Eligible = { row: ProfileRow; target: Exclude<ModelDispatch, { kind: 'none' }>; public: PublicAgentProfile }
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
function publicProfile(row: ProfileRow, target: Exclude<ModelDispatch, { kind: 'none' }>, skills: ProfileRow['skills']): PublicAgentProfile {
  return {
    id: row.id, name: row.definition.name, description: row.definition.description, roles: [...row.definition.roles], harness: target.entry.harness, model: target.model,
    // Only trusted, bounded metadata enters model context: never a body,
    // private path or source revision. The Decision may not infer capabilities
    // that were not declared here.
    skills: skills.slice(0, 12).map(skill => ({ id: skill.id, name: skill.name, description: skill.description.slice(0, 200), source: agentProfileSkillSource(skill.id) })),
  }
}
const SKILL_REASONS = { missing: 'skillMissing', disabled: 'skillDisabled', forbidden: 'skillForbidden', invalid: 'skillsChanged' } as const
async function eligibleProfiles(pool: Pool, scope: DispatchScope, rows: ProfileRow[], request: Partial<AgentProfileDispatchRequest>, deps: DispatchDependencies = {}, readOnly = false, deferStaleQuota = false) {
  const constraints = await requestConstraints(pool, scope, request)
  const eligible: Eligible[] = [], availability: Record<string, { available: boolean; reason?: string }> = {}
  for (const row of rows) {
    const definition = parseAgentProfile(row.definition)
    if (!definition.enabled || row.archivedAt) { availability[row.id] = { available: false, reason: row.archivedAt ? 'archived' : 'disabled' }; continue }
    const harness = definition.harness === 'auto' ? constraints.harness : definition.harness
    const fixed = definition.model.mode === 'fixed' ? definition.model : undefined
    if ((constraints.harness && harness && constraints.harness !== harness) || (fixed && ((constraints.harness && constraints.harness !== fixed.harness) || (request.asked?.model && request.asked.model !== fixed.model)))) {
      availability[row.id] = { available: false, reason: 'pinConflict' }; continue
    }
    // The stored envelope is the pinned version; the current source only has
    // to remain authorized. A text change never rewrites a saved Profile.
    const skills = row.skills
    if (!Array.isArray(skills) || agentProfileDigest(definition, skills) !== row.digest) { availability[row.id] = { available: false, reason: 'skillsChanged' }; continue }
    const states = await agentProfileSkillAvailability(pool, scope, skills)
    const unavailable = Object.values(states).find(state => !state.available)
    if (unavailable) { availability[row.id] = { available: false, reason: SKILL_REASONS[unavailable.reason ?? 'missing'] }; continue }
    const target = await (deps.resolve ?? resolveModelDispatch)(pool, scope, request.asked?.model ? request.asked : undefined, request.location, constraints.deviceId, {
      harness, agentId: request.agentId, withoutCloud: request.withoutCloud, cloudPurpose: request.cloudPurpose,
      ...(fixed ? { exactEntry: { id: `profile:${row.id}:${row.version}`, harness: fixed.harness, model: fixed.model, source: fixed.source } } : {}),
      bindSubscription: false, ...(readOnly ? { skipCatalogueRefresh: true, probeQuota: false, ...(deferStaleQuota ? { deferStaleQuota: true as const } : {}) } : {}),
    })
    availability[row.id] = target.kind === 'none' ? { available: false, reason: target.reason } : { available: true }
    if (target.kind !== 'none') eligible.push({ row, target, public: publicProfile(row, target, skills) })
  }
  return { eligible, availability, constraints }
}

/** Only the actor's authorized, currently runnable public summaries enter model context.
 * The mark rides along here so a reply can name a Profile as the UI draws it; the Decision input stays without it. */
export async function listPublicAgentProfiles(pool: Pool, scope: DispatchScope, request: Partial<AgentProfileDispatchRequest> = {}): Promise<(PublicAgentProfile & ProfileMarkValue)[]> {
  const member = await acquireProfileMembership(scope)
  try { return (await eligibleProfiles(pool, scope, await readProfileRows(pool, scope), request, {}, true)).eligible.map(item => ({ ...item.public, ...resolveProfileMark(item.public, item.row) })) }
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
    const builtin = request.profileId === BUILTIN_AGENT_PROFILE_ID
    const explicit = request.profileId && !builtin ? rows.find(row => row.id === request.profileId) : undefined
    if (request.profileId && !builtin && !explicit) return { available: false, reason: 'agentProfileNotFound' }
    if (explicit && !explicit.definition.enabled) return { available: false, reason: 'agentProfileDisabled' }
    if (!builtin && (explicit || rows.some(row => row.definition.enabled))) {
      const result = await eligibleProfiles(pool, scope, explicit ? [explicit] : rows, request, {}, true, options.deferStaleQuota)
      await member.check()
      if (result.eligible.length) return { available: true, ...(result.eligible.some(item => item.target.quotaCheckPending) ? { reason: 'quota_check_required' } : {}) }
      if (explicit || (!request.asked && !request.agentId)) return { available: false, reason: explicit ? result.availability[explicit.id]?.reason ?? 'agentProfileUnavailable' : 'agentProfileUnavailable' }
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
    const sourceId = entry.source.kind === 'subscription' ? entry.source.connectionId : entry.source.keyId
    const sourceLabel = labels.rows.find(label => label.id === sourceId)?.label || undefined
    const sourceIds = [...new Set(entries.filter(item => item.source.kind === entry.source.kind).map(item => item.source.kind === 'subscription' ? item.source.connectionId : item.source.keyId))]
    const sourceOrdinal = sourceIds.indexOf(sourceId) + 1
    return { harness: entry.harness, model: entry.model, source: entry.source, provider: candidates[index].provider, ...(sourceLabel ? { sourceLabel } : {}), sourceOrdinal, available: plan.kind !== 'none', ...(plan.kind === 'none' ? { reason: plan.reason } : {}) }
  })
  return { models, skills }
}
export async function readAgentProfileManagement(pool: Pool, scope: AgentProfileScope, preview: Pick<AgentProfileDispatchRequest, 'location' | 'deviceId'> = {}) {
  const member = await acquireProfileMembership(scope)
  try {
    const rows = await readProfileRows(pool, scope)
    const [catalog, { availability }, fallback] = await Promise.all([agentProfileCatalog(pool, scope), eligibleProfiles(pool, { ...scope, botId: null }, rows, preview, {}, true), resolveModelDispatch(pool, { ...scope, botId: null }, undefined, preview.location, preview.deviceId, { skipCatalogueRefresh: true, probeQuota: false, bindSubscription: false })])
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
  if (agentProfileDigest(definition, skills) !== selection.digest || digest(definition) !== digest(selection.definition) || digest(skills) !== digest(selection.skills) || (selection.instructions !== agentProfileInstructions(definition, skills) && selection.instructions !== agentProfileLegacyInstructions(definition, skills)) || selection.effort !== definition.effort || selection.name !== definition.name) throw new AgentProfileError('agentProfileSelectionInvalid')
  await assertProfileTarget(query, scope, selection)
}

/** Recheck only the current target after a host receipt has independently
 * established the frozen role. This never grants permission to use a Profile. */
export async function assertProfileTarget(query: ProfileQuery, scope: AgentProfileScope, selection: AgentProfileSelection): Promise<void> {
  validateProfileScope(scope)
  if (selection.scope?.ownerId !== scope.ownerId || selection.scope?.workspaceId !== scope.workspaceId) throw new AgentProfileError('agentProfileScopeNotFound', 404)
  const definition = selection.definition, entry = selection.targetEntry
  if (!entry || (definition.harness !== 'auto' && definition.harness !== entry.harness) || (definition.model.mode === 'fixed' && entryKey(definition.model) !== entryKey(entry))) throw new AgentProfileError('agentProfilePinConflict')
  if (selection.profileId !== BUILTIN_AGENT_PROFILE_ID && (selection.source === 'explicit' || selection.source === 'decision') && definition.model.mode === 'fixed') {
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
  // Catalogue/credential refresh and Decision can outlive the 20-second
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
        await member.check()
        await client.query('COMMIT')
      }
      return { target, ...(agentProfile ? { agentProfile } : {}), selectionMode }
    } catch (error) { if (!deps.transaction) await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { if (!deps.transaction) { await member?.close(); client.release() } }
  }
  const legacy = async () => {
    const constraints = await requestConstraints(pool, scope, request)
    const target = await (deps.resolve ?? resolveModelDispatch)(pool, scope, request.asked?.model ? request.asked : undefined, request.location, constraints.deviceId, { withoutCloud: request.withoutCloud, cloudPurpose: request.cloudPurpose, harness: constraints.harness ?? request.defaultHarness, agentId: request.agentId, bindSubscription: false,
      routing: { issueId: request.issueId, stage: request.stage, note: request.note, ...request.routing }, decision: deps.modelDecision })
    const agentProfile = target.kind === 'none' ? undefined : builtinAgentProfileSelection(scope, target.entry)
    return finalize(target, agentProfile, request.asked?.model ? 'picked' : 'preference')
  }
  if (request.defaultOnly && request.profileId && request.profileId !== BUILTIN_AGENT_PROFILE_ID) throw new AgentProfileError('agentProfilePinConflict')
  // A task-form Default pin and a host continuation of that same role agree.
  // Automatic selection and every explicit custom Profile retain their gates.
  if (request.defaultOnly || request.profileId === BUILTIN_AGENT_PROFILE_ID || (!request.profileId && !rows.some(row => row.definition.enabled))) return await legacy()
  const selectedRow = request.profileId ? rows.find(row => row.id === request.profileId) : undefined
  if (request.profileId && !selectedRow) throw new AgentProfileError('agentProfileNotFound', 404)
  if (selectedRow && !selectedRow.definition.enabled) throw new AgentProfileError('agentProfileDisabled')
  const { eligible, availability } = await eligibleProfiles(pool, scope, selectedRow ? [selectedRow] : rows, request, deps)
  if (!eligible.length) {
    if (selectedRow) throw new AgentProfileError(availability[selectedRow.id]?.reason === 'pinConflict' ? 'agentProfilePinConflict' : 'agentProfileUnavailable')
    // An explicit physical Agent/model wins even when the owner's profiles describe other work.
    if (request.asked || request.agentId) return await legacy()
    throw new AgentProfileError('agentProfileUnavailable')
  }
  let chosen: Eligible | undefined, reason: AgentProfileSelection['reason'] = 'explicit'
  let execution: Awaited<ReturnType<typeof invokeDecision>> | null = null
  if (request.profileId) chosen = eligible.find(item => item.row.id === request.profileId)
  else {
    z.uuid().parse(request.issueId)
    const { issueForUser } = await import('@/lib/issue-access')
    const issue = await issueForUser(scope.ownerId, request.issueId)
    if (!issue) throw new AgentProfileError('agentProfileScopeNotFound', 404)
    const catalog = eligible.map(item => item.public)
    const check = await deps.independentCheck?.()
    const input = maskFactoryNote(profileDecisionInput({ title: issue.title, content: JSON.stringify(issue.content).slice(0, 12_000), stage: request.stage ?? 'execute', note: request.note?.slice(0, 4000) }, catalog, deps.checkWork, check))
    execution = await hostedBillingScope.run({ workspaceId: scope.workspaceId, ownerId: scope.ownerId }, () => (deps.decision ?? invokeDecision)('factory-agent-profile', input, profileDecisionQuestions(catalog), undefined, { retainInvalidReceipt: true }))
    const result = profileDecisionSelection(catalog, execution?.answers ?? null)
    if ('unavailable' in result) {
      const error = new AgentProfileError('agentProfileDecisionUnavailable', 409, { detail: result.unavailable })
      const stage = ['triage', 'plan', 'spec', 'execute', 'review', 'verify', 'approval', 'publish', 'monitor'].includes(request.stage ?? '') ? request.stage : undefined
      logCodedError(error, { issueId: request.issueId, stage, ...profileDecisionDiagnostics(catalog, availability, execution?.answers), decisionExecutionId: execution?.execution.executionId })
      throw error
    }
    chosen = eligible.find(item => item.row.id === result.selected.id); reason = result.selected.reason
  }
  if (!chosen) throw new AgentProfileError('agentProfileSelectionInvalid')
  // The stored envelope is the exact pinned version; `eligibleProfiles` has
  // already rechecked that its sources remain authorized.
  const definition = parseAgentProfile(chosen.row.definition), skills = chosen.row.skills
  // Role selection happens first. Its fixed model and a person's explicit
  // model are never replaced; only an inherited model list is routed.
  if (definition.model.mode !== 'fixed' && !request.asked?.model) {
    const constraints = await requestConstraints(pool, scope, request)
    const routed = await (deps.resolve ?? resolveModelDispatch)(pool, scope, request.asked, request.location, constraints.deviceId, {
      harness: definition.harness === 'auto' ? constraints.harness : definition.harness,
      agentId: request.agentId, withoutCloud: request.withoutCloud, cloudPurpose: request.cloudPurpose, bindSubscription: false,
      routing: { issueId: request.issueId, stage: request.stage, note: request.note, effort: definition.effort, ...request.routing }, decision: deps.modelDecision,
    })
    if (routed.kind === 'none') throw new AgentProfileError('agentProfileModelUnavailable')
    chosen = { ...chosen, target: routed }
  }
  const selection: AgentProfileSelection = {
    profileId: chosen.row.id, version: chosen.row.version, digest: chosen.row.digest, name: definition.name,
    source: request.profileId ? 'explicit' : 'decision', reason, scope: { ownerId: scope.ownerId, workspaceId: scope.workspaceId }, definition, skills,
    instructions: agentProfileInstructions(definition, skills), ...(definition.effort ? { effort: definition.effort } : {}), targetEntry: chosen.target.entry,
    ...(execution ? { decision: execution.execution } : {}),
  }
  return finalize(chosen.target, selection, definition.model.mode === 'fixed' || request.asked?.model ? 'picked' : 'preference')
}
