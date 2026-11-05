import 'server-only'
import type { Pool } from 'pg'
import { z } from 'zod'
import { digest } from '@/lib/agent-kit/definition'
import { bindAgentToConnection, resolveModelDispatch, type ModelDispatch } from '@/lib/model-dispatch'
import { credentialStates, orderCandidates, readOrder, poolDevices } from '@/lib/model-order'
import { entryKey, planDispatch, type OrderEntry, type OrderHarness, type RunLocation } from '@/lib/model-order-plan'
import { cloudModelSupport } from '@/lib/cloud-template-models'
import { cloudReady } from '@/lib/rule-dispatch'
import { hostedBillingScope } from '@/lib/abuse/context'
import { invokeDecision } from '@/lib/coordinator/decide'
import { BUILTIN_AGENT_PROFILE_ID, BUILTIN_AGENT_PROFILE_VERSION, builtinAgentProfileDefinition, builtinAgentProfileSelection, AgentProfileError, agentProfileDigest, agentProfileInstructions, parseAgentProfile, type AgentProfileScope, type AgentProfileSelection } from './agent-profile-definition'
import { acquireProfileMembership, profileView, readProfileRow, readProfileRows, validateProfileScope, type ProfileMembership, type ProfileQuery, type ProfileRow } from './agent-profile-store'
import { agentProfileSkillsCatalog, resolveAgentProfileSkills } from './agent-profile-skills'
import { maskFactoryNote } from './note-mask'
import { profileDecisionQuestions, selectedProfileAnswer, type PublicAgentProfile } from './agent-profile-decision'

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
  cloudPurpose?: 'task' | 'desktop'
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
  membership?: (scope: AgentProfileScope) => Promise<ProfileMembership>
  resolve?: typeof resolveModelDispatch
  decision?: typeof invokeDecision
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
function publicProfile(row: ProfileRow, target: Exclude<ModelDispatch, { kind: 'none' }>): PublicAgentProfile {
  return { id: row.id, name: row.definition.name, description: row.definition.description, roles: [...row.definition.roles], harness: target.entry.harness, model: target.model }
}
async function eligibleProfiles(pool: Pool, scope: DispatchScope, rows: ProfileRow[], request: Partial<AgentProfileDispatchRequest>, deps: DispatchDependencies = {}, readOnly = false) {
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
    const skills = resolveAgentProfileSkills(definition.skills)
    if (agentProfileDigest(definition, skills) !== row.digest) { availability[row.id] = { available: false, reason: 'skillsChanged' }; continue }
    const target = await (deps.resolve ?? resolveModelDispatch)(pool, scope, request.asked?.model ? request.asked : undefined, request.location, constraints.deviceId, {
      harness, agentId: request.agentId, withoutCloud: request.withoutCloud, cloudPurpose: request.cloudPurpose,
      ...(fixed ? { exactEntry: { id: `profile:${row.id}:${row.version}`, harness: fixed.harness, model: fixed.model, source: fixed.source } } : {}),
      bindSubscription: false, ...(readOnly ? { skipCatalogueRefresh: true, probeQuota: false } : {}),
    })
    availability[row.id] = target.kind === 'none' ? { available: false, reason: target.reason } : { available: true }
    if (target.kind !== 'none') eligible.push({ row, target, public: publicProfile(row, target) })
  }
  return { eligible, availability, constraints }
}

/** Only the actor's authorized, currently runnable public summaries enter model context. */
export async function listPublicAgentProfiles(pool: Pool, scope: DispatchScope, request: Partial<AgentProfileDispatchRequest> = {}): Promise<PublicAgentProfile[]> {
  const member = await acquireProfileMembership(scope)
  try { return (await eligibleProfiles(pool, scope, await readProfileRows(pool, scope), request, {}, true)).eligible.map(item => item.public) }
  finally { await member.close() }
}

/** Read-only runtime availability for group routing and task previews. It uses
 * the same eligible set as dispatch, without selecting a role or binding a source. */
export async function agentProfileDispatchAvailability(pool: Pool, scope: DispatchScope, request: Partial<AgentProfileDispatchRequest> = {}): Promise<{ available: boolean; reason?: string }> {
  validateProfileScope(scope)
  const member = await acquireProfileMembership(scope)
  try {
    const rows = await readProfileRows(pool, scope)
    const explicit = request.profileId ? rows.find(row => row.id === request.profileId) : undefined
    if (request.profileId && !explicit) return { available: false, reason: 'agentProfileNotFound' }
    if (explicit && !explicit.definition.enabled) return { available: false, reason: 'agentProfileDisabled' }
    if (explicit || rows.some(row => row.definition.enabled)) {
      const result = await eligibleProfiles(pool, scope, explicit ? [explicit] : rows, request, {}, true)
      await member.check()
      if (result.eligible.length) return { available: true }
      if (explicit || (!request.asked && !request.agentId)) return { available: false, reason: explicit ? result.availability[explicit.id]?.reason ?? 'agentProfileUnavailable' : 'agentProfileUnavailable' }
    }
    const constraints = await requestConstraints(pool, scope, request)
    const target = await resolveModelDispatch(pool, scope, request.asked, request.location, constraints.deviceId, { harness: constraints.harness ?? request.defaultHarness, cloudPurpose: request.cloudPurpose, withoutCloud: request.withoutCloud, agentId: request.agentId, skipCatalogueRefresh: true, probeQuota: false, bindSubscription: false })
    await member.check()
    return target.kind === 'none' ? { available: false, reason: target.reason } : { available: true }
  } finally { await member.close() }
}

/** Settings projection: no provider probes, secret reads, or subscription binding writes. */
export async function agentProfileCatalog(pool: Pool, scope: AgentProfileScope) {
  const candidates = await orderCandidates(pool, scope)
  const order = await readOrder(pool, scope, candidates)
  const entries: OrderEntry[] = candidates.map(candidate => ({ id: `profile-catalog:${encodeURIComponent(entryKey(candidate))}`, harness: candidate.harness, model: candidate.model, source: candidate.source }))
  const [states, devices, connectedAgents, claudeReady, codexReady, labels] = await Promise.all([
    credentialStates(pool, scope, entries, candidates, undefined, { probe: false }), poolDevices(pool, scope.ownerId),
    pool.query<{ deviceId: string; harness: string }>('SELECT DISTINCT "deviceId",harness FROM agents WHERE "userId"=$1 AND "deviceId" IS NOT NULL', [scope.ownerId]),
    cloudReady(pool, { ...scope, botId: null, harness: 'claude_code' }), cloudReady(pool, { ...scope, botId: null, harness: 'codex' }),
    pool.query<{ id: string; label: string | null }>('SELECT id::text AS id,"accountLabel" AS label FROM byos_connections WHERE "ownerId"=$1 UNION ALL SELECT id::text AS id,name AS label FROM model_api_keys WHERE "ownerId"=$1', [scope.ownerId]),
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
  return { models, skills: agentProfileSkillsCatalog() }
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
    definition = parseAgentProfile(row.definition); skills = resolveAgentProfileSkills(definition.skills)
  }
  if (agentProfileDigest(definition, skills) !== selection.digest || digest(definition) !== digest(selection.definition) || digest(skills) !== digest(selection.skills) || selection.instructions !== agentProfileInstructions(definition, skills) || selection.effort !== definition.effort || selection.name !== definition.name) throw new AgentProfileError('agentProfileSelectionInvalid')
  await assertProfileTarget(query, scope, selection)
}

/** Recheck only the current target after a host receipt has independently
 * established the frozen role. This never grants permission to use a Profile. */
export async function assertProfileTarget(query: ProfileQuery, scope: AgentProfileScope, selection: AgentProfileSelection): Promise<void> {
  validateProfileScope(scope)
  if (selection.scope?.ownerId !== scope.ownerId || selection.scope?.workspaceId !== scope.workspaceId) throw new AgentProfileError('agentProfileScopeNotFound', 404)
  const definition = selection.definition, entry = selection.targetEntry
  if (!entry || (definition.harness !== 'auto' && definition.harness !== entry.harness) || (definition.model.mode === 'fixed' && entryKey(definition.model) !== entryKey(entry))) throw new AgentProfileError('agentProfilePinConflict')
  const candidates = await orderCandidates(query, scope)
  if (!candidates.some(candidate => entryKey(candidate) === entryKey(entry))) throw new AgentProfileError('agentProfileModelUnavailable')
  // Pin the source's current authorization row against a concurrent disconnect/delete.
  if (entry.source.kind === 'subscription') await query.query('SELECT id FROM byos_connections WHERE id=$1 FOR SHARE', [entry.source.connectionId])
  else await query.query('SELECT id FROM model_api_keys WHERE id=$1 FOR SHARE', [entry.source.keyId])
  const state = (await credentialStates(query, scope, [entry], candidates, undefined, { probe: false })).get(entry.id)
  if (!state?.credential.usable) throw new AgentProfileError('agentProfileModelUnavailable')
}

export async function resolveAgentProfileDispatch(pool: Pool, scope: DispatchScope, request: AgentProfileDispatchRequest, deps: DispatchDependencies = {}): Promise<AgentProfileDispatchResult> {
  validateProfileScope(scope)
  const member = await (deps.membership ?? acquireProfileMembership)(scope)
  try {
    const rows = await readProfileRows(pool, scope)
    const legacy = async () => {
      const constraints = await requestConstraints(pool, scope, request)
      const target = await (deps.resolve ?? resolveModelDispatch)(pool, scope, request.asked, request.location, constraints.deviceId, { withoutCloud: request.withoutCloud, cloudPurpose: request.cloudPurpose, harness: constraints.harness ?? request.defaultHarness, agentId: request.agentId })
      const agentProfile = target.kind === 'none' ? undefined : builtinAgentProfileSelection(scope, target.entry)
      if (agentProfile) await assertProfileSelection(pool, scope, agentProfile)
      await member.check(); return { target, ...(agentProfile ? { agentProfile } : {}), selectionMode: request.asked?.model ? 'picked' as const : 'preference' as const }
    }
    if (request.defaultOnly && request.profileId) throw new AgentProfileError('agentProfilePinConflict')
    if (request.defaultOnly || (!request.profileId && !rows.some(row => row.definition.enabled))) return await legacy()
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
    let chosen: Eligible | undefined, reason = 'Explicit Profile selection.'
    let execution: Awaited<ReturnType<typeof invokeDecision>> | null = null
    if (request.profileId) chosen = eligible.find(item => item.row.id === request.profileId)
    else {
      z.uuid().parse(request.issueId)
      const { issueForUser } = await import('@/lib/issue-access')
      const issue = await issueForUser(scope.ownerId, request.issueId)
      if (!issue) throw new AgentProfileError('agentProfileScopeNotFound', 404)
      const catalog = eligible.map(item => item.public)
      const input = maskFactoryNote(JSON.stringify({ task: { title: issue.title, content: JSON.stringify(issue.content).slice(0, 12_000), stage: request.stage ?? 'execute', note: request.note?.slice(0, 4000) }, candidates: catalog }))
      execution = await hostedBillingScope.run({ workspaceId: scope.workspaceId, ownerId: scope.ownerId }, () => (deps.decision ?? invokeDecision)('factory-agent-profile', input, profileDecisionQuestions(catalog)))
      const selected = selectedProfileAnswer(catalog, execution?.answers ?? null)
      if (!selected) throw new AgentProfileError('agentProfileDecisionUnavailable')
      chosen = eligible.find(item => item.row.id === selected.id); reason = selected.reason
    }
    if (!chosen) throw new AgentProfileError('agentProfileSelectionInvalid')
    const definition = parseAgentProfile(chosen.row.definition), skills = resolveAgentProfileSkills(definition.skills)
    const selection: AgentProfileSelection = {
      profileId: chosen.row.id, version: chosen.row.version, digest: chosen.row.digest, name: definition.name,
      source: request.profileId ? 'explicit' : 'decision', reason, scope: { ownerId: scope.ownerId, workspaceId: scope.workspaceId }, definition, skills,
      instructions: agentProfileInstructions(definition, skills), ...(definition.effort ? { effort: definition.effort } : {}), targetEntry: chosen.target.entry,
      ...(execution ? { decision: execution.execution } : {}),
    }
    const client = await pool.connect()
    let target = chosen.target
    try {
      await client.query('BEGIN'); await assertProfileSelection(client, scope, selection); await member.check()
      if (target.kind === 'device' && target.entry.source.kind === 'subscription') target = { ...target, subscriptionBindingId: await bindAgentToConnection(client, scope, target.agentId, target.entry.harness, target.entry.source.connectionId, target.entry.model) }
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
    return { target, agentProfile: selection, selectionMode: definition.model.mode === 'fixed' || request.asked?.model ? 'picked' : 'preference' }
  } finally { await member.close() }
}
