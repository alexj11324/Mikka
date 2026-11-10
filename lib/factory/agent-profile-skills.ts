import 'server-only'
import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { ProfileRunSkill } from '@mikka/protocol/skill'
import { digest, skillDefinitionSchema } from '@/lib/agent-kit/definition'
import { skillDescription } from '@/lib/plugins/skill-metadata'
import { AGENT_PROFILE_SKILL_ID, AgentProfileError, agentProfileSkillRuntimeId, type AgentProfileScope, type AgentProfileSkill, type AgentProfileSkillSource } from './agent-profile-definition'

type ProfileQuery = Pick<Pool | PoolClient, 'query'>

/** Reviewed, instruction-only official capabilities. References cannot mount
 * arbitrary files, fetch URLs, run hooks, grant tools, or change the host's
 * permission policy. An id is immutable: a revised text is a new id, so a
 * frozen Profile keeps the exact version it saved. */
const definitions = [
  {
    id: 'implementation-evidence', name: 'Implementation evidence', description: 'Tie changes and verification evidence to the task acceptance criteria.', version: 1,
    content: 'Read the task acceptance criteria before changing code. Keep the change within the authorized repository and scope. Verify the affected behavior with the existing project checks and actual observable results. Record which criteria passed, what commands or checks ran, and which criteria remain unverified with the concrete reason. Never claim a test ran from a suggested command or a prior run. Preserve the task candidate and source revision in the final report. Do not merge or publish unless the host supplied the required human authorization.',
  },
  {
    id: 'independent-review', name: 'Independent review', description: 'Review the frozen candidate independently and report actionable findings.', version: 1,
    content: 'Review the exact candidate and acceptance criteria supplied by the host. Independently inspect the relevant changes, behavior, and verification evidence; do not treat the implementer summary as proof. Check authorization boundaries, regressions, data integrity, and failure handling in proportion to the change. Report concrete findings with affected files and reproducible evidence, or state what was checked when no actionable finding remains. Identify missing evidence explicitly. Honor the task review limit and leave acceptance and merge to the human approval flow.',
  },
  {
    id: 'systematic-debugging', name: 'Systematic debugging', description: 'Reproduce a failure and verify the smallest justified root-cause fix.', version: 1,
    content: 'Start from the observed failure and expected behavior. Reproduce it in the authorized environment, inspect the evidence, and state a testable root-cause hypothesis. Change the smallest responsible boundary, then repeat the failing check and relevant regression checks. Separate observations from inferences. Stop speculative changes when evidence is missing and report the exact blocker. Never weaken authorization, substitute fake success, or expose credentials in debugging output.',
  },
  {
    id: 'test-driven-development', name: 'Test-driven development', description: 'Turn the requirement into a failing check, then make the smallest change pass.', version: 1,
    content: 'Express the required behavior as an executable test or command before changing the implementation, and run it to observe the failure. Change only the code needed to make that check pass, then run the check again and the neighboring regression checks. Refactor only while the checks stay green. Do not weaken, skip, or delete a check to get a pass, and do not treat a passing build as proof of behavior you never exercised. Record the exact commands and their observed results.',
  },
  {
    id: 'verification-before-completion', name: 'Verification before completion', description: 'Separate verified results from planned or assumed results before reporting.', version: 1,
    content: 'Before reporting completion, list every claim the task requires and the observation that supports it. Re-run the relevant project command on the final state and read its actual output; a previous run, a suggested command, or a passing unrelated suite is not evidence. Treat unobserved behavior as unverified and say why. Keep the tested revision fixed: if files change after verification, run the affected checks again. Never describe an unrun check as passed.',
  },
  {
    id: 'performance-investigation', name: 'Performance investigation', description: 'Measure a performance problem before optimizing, and prove the change.', version: 1,
    content: 'Start from a concrete, reproducible measurement of the slow or costly path in the authorized environment: command, input, environment, and observed numbers. Identify the dominant cost with available evidence instead of guessing. Make the smallest change that addresses it, then repeat the same measurement under the same conditions and compare. Keep correctness checks green. Report absolute numbers, the comparison basis, and any remaining cost or unmeasured path rather than claiming a general speedup.',
  },
  {
    id: 'security-review', name: 'Security review', description: 'Check trust boundaries, authorization, injection and secret handling in a change.', version: 1,
    content: 'Map the new or changed boundary: who can call it, what they can supply, and which tenant or owner data it reaches. Verify authorization and ownership checks at the authoritative boundary rather than in client code. Look for injection into SQL, shell, HTML or templates, unsafe deserialization, path traversal, and unvalidated redirects or URLs. Confirm secrets and credentials never enter source, logs, error text, URLs or model-visible output. Treat dependency and configuration changes as security-relevant. Report each finding with a concrete path and evidence, and do not approve an untested boundary.',
  },
] as const

/** The canonical envelope keeps exactly the pre-existing fields so every
 * Profile saved before namespaced sources keeps its digest. */
const catalog: readonly AgentProfileSkill[] = definitions.map(skill => {
  // Reuse AgentKit's exact instruction-only Skill schema. Profiles add only the
  // immutable version/content envelope consumed by the existing native worker.
  const parsed = skillDefinitionSchema.parse({ id: skill.id, name: skill.name, description: skill.description, body: skill.content })
  const validated = { id: parsed.id, name: parsed.name, description: parsed.description, version: skill.version, content: parsed.body }
  return { ...validated, digest: digest(validated) }
})
const official = new Map(catalog.map(skill => [skill.id, skill]))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REPOSITORY = /^repository:([a-z0-9][a-z0-9-]{0,63})$/i

export type AgentProfileSkillUnavailableReason = 'missing' | 'disabled' | 'forbidden' | 'invalid'
export type AgentProfileSkillAvailability = { available: boolean; reason?: AgentProfileSkillUnavailableReason }
export type AgentProfileSkillCatalogItem = Pick<AgentProfileSkill, 'id' | 'name' | 'description' | 'version' | 'digest'> & {
  source: AgentProfileSkillSource; available: boolean; reason?: AgentProfileSkillUnavailableReason
  /** A personal Skill in a team workspace can be shared from the editor. */
  shareable?: boolean
  /** This personal Skill is already shared to the current workspace. */
  shared?: boolean
}

export function agentProfileSkillSource(id: string): AgentProfileSkillSource {
  const prefix = id.includes(':') ? id.slice(0, id.indexOf(':')) : 'official'
  return prefix === 'personal' || prefix === 'workspace' || prefix === 'repository' || prefix === 'official' ? prefix : 'official'
}

/** The official catalogue is synchronous: it is a compiled, reviewed set. */
export function agentProfileSkillsCatalog(): AgentProfileSkillCatalogItem[] {
  return catalog.map(({ content: _content, ...skill }) => ({ ...skill, source: 'official' as const, available: true }))
}

function repositorySkill(id: string, slug: string): AgentProfileSkill {
  return {
    id, name: slug, description: '', version: 1, source: 'repository', content: '',
    digest: createHash('sha256').update(`mikka.repository-skill\0${slug}`).digest('hex'),
  }
}

/** Synchronous resolution for the official and declared repository sources.
 * Personal and workspace sources need the owner's current installations and
 * use `resolveAgentProfileSkillsFor`. */
export function resolveAgentProfileSkills(ids: readonly string[]): AgentProfileSkill[] {
  return ids.map(id => {
    const repository = REPOSITORY.exec(id)
    if (repository) return repositorySkill(id, repository[1].toLowerCase())
    const skill = official.get(id.replace(/^official:/, ''))
    if (skill && AGENT_PROFILE_SKILL_ID.test(id)) return id.startsWith('official:') ? { ...skill, id } : { ...skill }
    throw new AgentProfileError('agentProfileSkillUnavailable', 400, { detail: 'missing' })
  })
}

type InstalledRow = { id: string; name: string; userId: string; sha256: string; enabled: boolean; body: string; sourceRevision: string }
type SkillSourceState =
  | { available: true; kind: 'official'; skill: AgentProfileSkill }
  | { available: true; kind: 'repository'; slug: string }
  | { available: true; kind: 'installed'; source: 'personal' | 'workspace'; row: InstalledRow }
  | { available: false; reason: AgentProfileSkillUnavailableReason }

const PERSONAL_COLUMNS = 'id,name,user_id AS "userId",sha256,enabled,body,source_revision AS "sourceRevision"'
const SHARED_COLUMNS = 's.id,s.name,s.user_id AS "userId",s.sha256,s.enabled,s.body,s.source_revision AS "sourceRevision"'

function splitIds(ids: readonly string[]) {
  const personal: { raw: string; id: string }[] = [], workspace: { raw: string; id: string }[] = [], repository: { raw: string; slug: string }[] = [], invalid: string[] = []
  for (const raw of ids) {
    const match = /^(personal|workspace):(.+)$/i.exec(raw)
    if (match) {
      const id = match[2].toLowerCase()
      if (!UUID.test(id)) { invalid.push(raw); continue }
      ;(match[1].toLowerCase() === 'personal' ? personal : workspace).push({ raw, id })
      continue
    }
    const repo = REPOSITORY.exec(raw)
    if (repo) { repository.push({ raw, slug: repo[1].toLowerCase() }); continue }
    const name = raw.replace(/^official:/, '')
    if (official.has(name) && AGENT_PROFILE_SKILL_ID.test(raw)) continue
    invalid.push(raw)
  }
  return { personal, workspace, repository, invalid }
}

async function workspaceMembers(workspaceId: string, userIds: readonly string[]): Promise<Set<string>> {
  const { workspacePool } = await import('@/lib/workspace-db')
  const { rows } = await workspacePool.query<{ userId: string }>(`SELECT "userId" FROM mikka_workspace_members
    WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status='active'`, [workspaceId, [...new Set(userIds)]])
  return new Set(rows.map(row => row.userId))
}

async function workspaceSkillAllowed(workspaceId: string, ownerId: string, skillId: string) {
  try {
    const { organizationResourceAllowed } = await import('@/lib/governance/resource-access')
    return await organizationResourceAllowed(workspaceId, 'skill', skillId, ownerId)
  } catch { return false }
}

/** Only a team workspace has an explicit-share model; a personal workspace
 * consists of its owner, so there is nothing to share to. */
async function workspaceSkillCanShare(workspaceId: string) {
  try {
    const { workspacePool } = await import('@/lib/workspace-db')
    const { rows: [row] } = await workspacePool.query<{ kind: string }>('SELECT kind FROM mikka_workspaces WHERE id=$1', [workspaceId])
    return row?.kind === 'team'
  } catch { return false }
}

/** One read of every selected source's current authorization. Content travels
 * only through `resolveAgentProfileSkillsFor`; availability checks stay small. */
export async function agentProfileSkillStates(query: ProfileQuery, scope: AgentProfileScope, ids: readonly string[]): Promise<Map<string, SkillSourceState>> {
  const states = new Map<string, SkillSourceState>()
  const { personal, workspace, repository, invalid } = splitIds(ids)
  for (const raw of invalid) states.set(raw, { available: false, reason: 'invalid' })
  for (const id of ids) {
    if (id.includes(':') && !id.startsWith('official:')) continue
    const name = id.startsWith('official:') ? id.slice('official:'.length) : id
    const skill = official.get(name)
    if (skill) states.set(id, { available: true, kind: 'official', skill: { ...skill, id } })
  }
  for (const { raw, slug } of repository) states.set(raw, { available: true, kind: 'repository', slug })
  if (personal.length) {
    const { rows } = await query.query<InstalledRow>(`SELECT ${PERSONAL_COLUMNS} FROM personal_skills WHERE user_id=$1 AND id=ANY($2::uuid[])`, [scope.ownerId, personal.map(item => item.id)])
    for (const { raw, id } of personal) {
      const row = rows.find(item => item.id.toLowerCase() === id)
      states.set(raw, row ? row.enabled ? { available: true, kind: 'installed', source: 'personal', row } : { available: false, reason: 'disabled' } : { available: false, reason: 'missing' })
    }
  }
  if (workspace.length) {
    const { rows } = await query.query<InstalledRow>(`SELECT ${SHARED_COLUMNS} FROM personal_skill_workspace_shares g
      JOIN personal_skills s ON s.id=g.skill_id WHERE g.workspace_id=$1 AND s.id=ANY($2::uuid[])`, [scope.workspaceId, workspace.map(item => item.id)])
    for (const { raw, id } of workspace) {
      const row = rows.find(item => item.id.toLowerCase() === id)
      states.set(raw, row ? { available: true, kind: 'installed', source: 'workspace', row } : { available: false, reason: 'missing' })
    }
    const members = await workspaceMembers(scope.workspaceId, rows.map(row => row.userId))
    for (const { raw, id } of workspace) {
      const state = states.get(raw)
      if (!state?.available || state.kind !== 'installed') continue
      if (!members.has(state.row.userId) || !await workspaceSkillAllowed(scope.workspaceId, state.row.userId, id)) states.set(raw, { available: false, reason: 'forbidden' })
    }
  }
  return states
}

function installedSkill(id: string, source: 'personal' | 'workspace', row: InstalledRow): AgentProfileSkill {
  const body = row.body.trim()
  if (!body || body.length > 20_000) throw new AgentProfileError('agentProfileSkillUnavailable', 400, { detail: 'invalid' })
  return {
    id, source, version: 1, name: row.name.trim().slice(0, 80) || id, description: skillDescription(body, row.name),
    digest: /^[0-9a-f]{64}$/i.test(row.sha256) ? row.sha256.toLowerCase() : createHash('sha256').update(row.body).digest('hex'),
    content: body, sourceRevision: row.sourceRevision.slice(0, 200),
  }
}

/** Full resolution for save and dispatch. The owner's current installation is
 * read here once; the returned envelope is frozen with the Profile version. */
export async function resolveAgentProfileSkillsFor(query: ProfileQuery, scope: AgentProfileScope, ids: readonly string[]): Promise<AgentProfileSkill[]> {
  const states = await agentProfileSkillStates(query, scope, ids)
  return ids.map(id => {
    const state = states.get(id)!
    if (state.available) {
      if (state.kind === 'official') return { ...state.skill }
      if (state.kind === 'repository') return repositorySkill(id, state.slug)
      return installedSkill(id, state.source, state.row)
    }
    throw new AgentProfileError('agentProfileSkillUnavailable', 400, { detail: state.reason, cause: new Error(`profile skill ${state.reason}`) })
  })
}

/** The current authorization of already frozen skills, without reading bodies.
 * A started or edited Profile keeps its pinned text, but a disabled, revoked or
 * removed source never runs again. */
export async function agentProfileSkillAvailability(query: ProfileQuery, scope: AgentProfileScope, skills: readonly AgentProfileSkill[]): Promise<Record<string, AgentProfileSkillAvailability>> {
  const states = await agentProfileSkillStates(query, scope, skills.map(skill => skill.id))
  return Object.fromEntries(skills.map(skill => {
    const state = states.get(skill.id)!
    return [skill.id, state.available ? { available: true } : { available: false, reason: state.reason }]
  }))
}

/** The Settings catalogue: official, the owner's installations (including
 * disabled ones with their reason), and skills explicitly shared to this
 * workspace. Repository skills are discovered by the daemon from the task
 * checkout and are declared by name in the editor. */
export async function agentProfileSkillCatalog(query: ProfileQuery, scope: AgentProfileScope): Promise<AgentProfileSkillCatalogItem[]> {
  const items: AgentProfileSkillCatalogItem[] = agentProfileSkillsCatalog()
  const { rows: personal } = await query.query<InstalledRow>(`SELECT ${PERSONAL_COLUMNS} FROM personal_skills WHERE user_id=$1 ORDER BY created_at,id`, [scope.ownerId])
  const canShare = personal.length > 0 && await workspaceSkillCanShare(scope.workspaceId)
  const sharedIds = new Set((await query.query<{ skillId: string }>(`SELECT skill_id AS "skillId" FROM personal_skill_workspace_shares WHERE workspace_id=$1`, [scope.workspaceId])).rows.map(row => row.skillId.toLowerCase()))
  for (const row of personal) items.push({
    id: `personal:${row.id}`, name: row.name.trim().slice(0, 80) || row.id, description: skillDescription(row.body, row.name),
    version: 1, digest: /^[0-9a-f]{64}$/i.test(row.sha256) ? row.sha256.toLowerCase() : createHash('sha256').update(row.body).digest('hex'),
    source: 'personal', available: row.enabled, ...(row.enabled ? {} : { reason: 'disabled' as const }),
    shareable: canShare, shared: sharedIds.has(row.id.toLowerCase()),
  })
  const { rows: shared } = await query.query<InstalledRow>(`SELECT ${SHARED_COLUMNS} FROM personal_skill_workspace_shares g
    JOIN personal_skills s ON s.id=g.skill_id WHERE g.workspace_id=$1 ORDER BY s.created_at,s.id`, [scope.workspaceId])
  if (shared.length) {
    const members = await workspaceMembers(scope.workspaceId, shared.map(row => row.userId))
    for (const row of shared) {
      const allowed = members.has(row.userId) && await workspaceSkillAllowed(scope.workspaceId, row.userId, row.id)
      items.push({
        id: `workspace:${row.id}`, name: row.name.trim().slice(0, 80) || row.id, description: skillDescription(row.body, row.name),
        version: 1, digest: /^[0-9a-f]{64}$/i.test(row.sha256) ? row.sha256.toLowerCase() : createHash('sha256').update(row.body).digest('hex'),
        source: 'workspace', available: row.enabled && allowed, shared: true,
        ...(row.enabled && allowed ? {} : { reason: row.enabled ? 'forbidden' as const : 'disabled' as const }),
      })
    }
  }
  return items
}

/** Freeze the assigned bodies for the owner's daemon. Only the daemon receives
 * the text; the public Decision input and the run-detail projection never do. */
export function profileSkillRunAssignment(skills: readonly AgentProfileSkill[]) {
  const profileSkills: ProfileRunSkill[] = [], repositorySkills: string[] = []
  for (const skill of skills) {
    const runtimeId = agentProfileSkillRuntimeId(skill.id), source = agentProfileSkillSource(skill.id)
    if (source === 'repository') {
      const match = REPOSITORY.exec(runtimeId)
      if (match && !repositorySkills.includes(match[1].toLowerCase())) repositorySkills.push(match[1].toLowerCase())
      continue
    }
    if (!skill.content) continue
    profileSkills.push({
      id: runtimeId, name: skill.name, description: skill.description, source, digest: createHash('sha256').update(skill.content).digest('hex'),
      instructions: skill.content,
    })
  }
  return { ...(profileSkills.length ? { profileSkills } : {}), ...(repositorySkills.length ? { repositorySkills } : {}) }
}
