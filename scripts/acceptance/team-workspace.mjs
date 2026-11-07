/** Normal same-account team selection for the shared production acceptance account.
 * The policy identity is established by AGENTS.md and the owner's public comment
 * https://github.com/alexj11324/Mikka/issues/1504#issuecomment-6691409495.
 * The API proves active admin membership, not workspace creator/owner identity. */
import { createHash } from 'node:crypto'
import { decode, DESKTOP_RPC_VERSION } from '../../lib/desktop-rpc/wire.ts'

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UUID = new RegExp('^' + UUID_SOURCE + '$')
const canonicalUuid = value => typeof value === 'string' && value.length === 36 && UUID.test(value)
const POLICY_ADMIN_EMAIL_SHA256 = '0049e13c050f799070a7d1a95bb843f2a0519b5e8732bf6986e2e1613b8941c3'
const DETAILS = new Set(['owner_identity', 'workspace_read', 'team_missing', 'team_ambiguous',
  'team_identity', 'candidate_read', 'candidate_identity', 'team_admin_missing', 'team_admin_ambiguous',
  'switch_request', 'switch_response', 'workspace_changed', 'session_read', 'session_changed', 'unknown'])

export class TeamWorkspaceError extends Error {
  constructor(detail, { cause } = {}) {
    super('team_workspace_failed', { cause })
    this.name = 'TeamWorkspaceError'
    this.code = 'team_workspace_failed'
    this.detail = DETAILS.has(detail) ? detail : 'unknown'
  }
}
const check = (ok, detail) => { if (!ok) throw new TeamWorkspaceError(detail) }

export function publicTeamWorkspaceFailure(error) {
  return { code: 'team_workspace_failed',
    detail: error instanceof TeamWorkspaceError ? error.detail : 'unknown' }
}

export function isTeamWorkspaceReadPath(path) {
  return path === '/mikka/api/workspace' || typeof path === 'string' &&
    path.startsWith('/mikka/api/workspace?workspace=') && canonicalUuid(path.slice('/mikka/api/workspace?workspace='.length))
}

export function isTeamWorkspaceSwitchRequest(body) {
  return body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === 3 && body.version === DESKTOP_RPC_VERSION
    && body.action === 'workspace.switchWorkspace' && Array.isArray(body.args)
    && body.args.length === 1 && canonicalUuid(body.args[0])
}

function policyAdmins(settings, ownerId, detail) {
  check(Array.isArray(settings.members) && settings.members.every(member =>
    member && typeof member.userId === 'string' && member.userId.length > 0 &&
    typeof member.email === 'string' && member.email.trim().length > 0 &&
    ['member', 'admin'].includes(member.role) && ['active', 'suspended'].includes(member.status)) &&
    new Set(settings.members.map(member => member.userId)).size === settings.members.length, detail)
  return settings.members.filter(member => member.userId !== ownerId && member.role === 'admin' &&
    member.status === 'active' && createHash('sha256').update(member.email.trim().toLowerCase()).digest('hex') === POLICY_ADMIN_EMAIL_SHA256)
}

/** json uses the caller's existing origin, credentials, time budget and cookie handling.
 * It returns the HTTP JSON value. No cookie is fabricated or copied by this helper.
 * Candidate query UUIDs come only from this request's authorized choices list. */
export async function selectTeamWorkspace({ ownerId, json, onSelected }) {
  check(typeof ownerId === 'string' && ownerId.length > 0 && typeof json === 'function', 'owner_identity')
  check(onSelected === undefined || typeof onSelected === 'function', 'owner_identity')
  const request = async (path, body, detail) => {
    try { return await json(path, body) }
    catch (error) { throw new TeamWorkspaceError(detail, { cause: error }) }
  }
  const initial = await request('/mikka/api/workspace', undefined, 'workspace_read')
  check(initial?.currentUserId === ownerId && Array.isArray(initial.choices), 'owner_identity')
  const teams = initial.choices.filter(choice => choice?.kind === 'team')
  check(teams.length > 0, 'team_missing')
  check(teams.length <= 32 && teams.every(choice => canonicalUuid(choice.id) &&
    initial.choices.filter(item => item?.id === choice.id).length === 1), 'team_identity')
  const teamIds = teams.map(choice => choice.id).sort()
  const matches = []
  for (const { id } of teams) {
    const candidate = await request('/mikka/api/workspace?workspace=' + id, undefined, 'candidate_read')
    check(candidate?.currentUserId === ownerId && candidate.workspace?.id === id &&
      candidate.workspace.kind === 'team' && ['member', 'admin'].includes(candidate.role), 'candidate_identity')
    const admins = policyAdmins(candidate, ownerId, 'candidate_identity')
    for (const admin of admins) matches.push({ workspaceId: id, adminId: admin.userId })
  }
  check(matches.length > 0, 'team_admin_missing')
  check(matches.length === 1, 'team_admin_ambiguous')
  const { workspaceId, adminId } = matches[0]
  const response = await request('/mikka/api/rpc', {
    version: DESKTOP_RPC_VERSION, action: 'workspace.switchWorkspace', args: [workspaceId],
  }, 'switch_request')
  check(response?.version === DESKTOP_RPC_VERSION && response.ok === true, 'switch_response')
  let switched
  try { switched = decode(response.result) }
  catch (error) { throw new TeamWorkspaceError('switch_response', { cause: error }) }
  check(switched?.ok === true && switched.data?.workspaceId === workspaceId, 'switch_response')
  const selected = await request('/mikka/api/workspace', undefined, 'workspace_read')
  check(selected?.currentUserId === ownerId && selected.workspace?.id === workspaceId &&
    selected.workspace.kind === 'team' && ['member', 'admin'].includes(selected.role) &&
    Array.isArray(selected.choices) &&
    JSON.stringify(selected.choices.filter(choice => choice?.kind === 'team').map(choice => choice.id).sort()) === JSON.stringify(teamIds),
  'workspace_changed')
  const selectedAdmins = policyAdmins(selected, ownerId, 'workspace_changed')
  check(selectedAdmins.length === 1 && selectedAdmins[0].userId === adminId, 'workspace_changed')
  const session = await request('/mikka/api/auth/get-session', undefined, 'session_read')
  check(session?.user?.id === ownerId, 'session_changed')
  // These private references are for in-memory authorization comparisons only;
  // the public evidence below remains unchanged and contains no account IDs.
  await onSelected?.({ workspaceId, adminId })
  return {
    teamWorkspaceConfirmed: true,
    teamWorkspaceHash: createHash('sha256').update('team-workspace\0' + workspaceId).digest('hex'),
    teamSelectionBasis: 'unique-active-admin-identity-match',
    teamOwnerAttribution: 'AGENTS.md-and-owner-comment-1504-6691409495',
    teamAdminMembershipVerified: true,
  }
}
