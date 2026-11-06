/** Normal same-account team selection for the shared production acceptance account.
 * The account's association with Alex's team comes from AGENTS.md; the API proves
 * its unique active team membership, not independent creator/owner identity. */
import { createHash } from 'node:crypto'
import { decode, DESKTOP_RPC_VERSION } from '../../lib/desktop-rpc/wire.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DETAILS = new Set(['owner_identity', 'workspace_read', 'team_missing', 'team_ambiguous',
  'team_identity', 'switch_request', 'switch_response', 'workspace_changed', 'session_read',
  'session_changed', 'unknown'])

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

export function isTeamWorkspaceSwitchRequest(body) {
  return body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === 3 && body.version === DESKTOP_RPC_VERSION
    && body.action === 'workspace.switchWorkspace' && Array.isArray(body.args)
    && body.args.length === 1 && typeof body.args[0] === 'string' && UUID.test(body.args[0])
}

/** json uses the caller's existing origin, credentials, time budget and cookie handling.
 * It returns the HTTP JSON value. No cookie is fabricated or copied by this helper. */
export async function selectTeamWorkspace({ ownerId, json }) {
  check(typeof ownerId === 'string' && ownerId.length > 0 && typeof json === 'function', 'owner_identity')
  const request = async (path, body, detail) => {
    try { return await json(path, body) }
    catch (error) { throw new TeamWorkspaceError(detail, { cause: error }) }
  }
  const initial = await request('/mikka/api/workspace', undefined, 'workspace_read')
  check(initial?.currentUserId === ownerId && Array.isArray(initial.choices), 'owner_identity')
  const teams = initial.choices.filter(choice => choice?.kind === 'team')
  check(teams.length > 0, 'team_missing')
  check(teams.length === 1, 'team_ambiguous')
  const workspaceId = teams[0].id
  check(typeof workspaceId === 'string' && UUID.test(workspaceId)
    && initial.choices.filter(choice => choice?.id === workspaceId).length === 1, 'team_identity')
  const response = await request('/mikka/api/rpc', {
    version: DESKTOP_RPC_VERSION, action: 'workspace.switchWorkspace', args: [workspaceId],
  }, 'switch_request')
  check(response?.version === DESKTOP_RPC_VERSION && response.ok === true, 'switch_response')
  let switched
  try { switched = decode(response.result) }
  catch (error) { throw new TeamWorkspaceError('switch_response', { cause: error }) }
  check(switched?.ok === true && switched.data?.workspaceId === workspaceId, 'switch_response')
  const selected = await request('/mikka/api/workspace', undefined, 'workspace_read')
  check(selected?.currentUserId === ownerId && selected.workspace?.id === workspaceId
    && selected.workspace.kind === 'team' && ['member', 'admin'].includes(selected.role)
    && Array.isArray(selected.choices)
    && selected.choices.filter(choice => choice?.kind === 'team').length === 1
    && selected.choices.some(choice => choice?.kind === 'team' && choice.id === workspaceId), 'workspace_changed')
  const session = await request('/mikka/api/auth/get-session', undefined, 'session_read')
  check(session?.user?.id === ownerId, 'session_changed')
  return {
    teamWorkspaceConfirmed: true,
    teamWorkspaceHash: createHash('sha256').update('team-workspace\0' + workspaceId).digest('hex'),
    teamSelectionBasis: 'unique-active-team-membership',
    teamOwnerAttribution: 'AGENTS.md-shared-account-team',
  }
}
