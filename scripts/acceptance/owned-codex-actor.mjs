import { createHash } from 'node:crypto'

// Explicit issue #1918 authorization. This is a separate case, never a SMOKE fallback.
export const OWNED_CODEX_ACTOR = 'authorized_2023_codex'
export const isOwnedCodexEmail = email => typeof email === 'string' && email.trim().toLowerCase() === 'alexjiang20232024@gmail.com'
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const check = (value, code) => { if (!value) throw Error(`startup_${code}`) }

/** Infisical prod:/ ALEX_TEST_EMAIL/PASSWORD are injected as this complete
 * environment pair by the operator; no credential is persisted or copied. */
export function ownedCodexAccount(env) {
  const email = env.MIKKA_TEST_ACCOUNT_EMAIL, password = env.MIKKA_TEST_ACCOUNT_PASSWORD
  check(isOwnedCodexEmail(email) && typeof password === 'string' && password.length > 0, 'owned_account_required')
  return { email: email.trim().toLowerCase(), password }
}

/** Same normal personal-workspace proof as run-observability. Only this new
 * session switches; current membership and the exact account are rechecked. */
export async function selectOwnedCodexWorkspace(client, { ownerId, workspace }, rememberOriginal = () => {}) {
  const initial = await client.json('/api/workspace')
  const choices = initial.choices?.filter(value => value.kind === 'personal')
  check(typeof ownerId === 'string' && ownerId.length > 0 && initial.currentUserId === ownerId
    && UUID.test(initial.workspace?.id ?? '') && initial.choices?.some(value => value.id === initial.workspace.id)
    && choices?.length === 1 && UUID.test(choices[0].id), 'owned_workspace_mismatch')
  rememberOriginal(initial.workspace.id)
  const workspaceId = choices[0].id
  check(!workspace || workspace === workspaceId, 'owned_workspace_mismatch')
  const owned = value => value.currentUserId === ownerId && value.workspace?.id === workspaceId
    && value.workspace.kind === 'personal' && value.role === 'admin' && value.members?.length === 1
    && value.members[0].userId === ownerId && value.members[0].role === 'admin' && value.members[0].status === 'active'
  check(owned(initial.workspace.id === workspaceId ? initial : await client.json('/api/workspace?workspace=' + workspaceId)), 'owned_workspace_mismatch')
  if (initial.workspace.id !== workspaceId) {
    const switched = await client.rpc('workspace.switchWorkspace', [workspaceId])
    check(switched.workspaceId === workspaceId, 'owned_workspace_mismatch')
  }
  check(owned(await client.json('/api/workspace')), 'owned_workspace_mismatch')
  const session = await client.json('/api/auth/get-session')
  check(session.user?.id === ownerId && isOwnedCodexEmail(session.user.email), 'session_identity_mismatch')
  return { actor: OWNED_CODEX_ACTOR, ownerId, workspaceId, evidence: { kind: 'personal',
    workspaceHash: createHash('sha256').update('personal-workspace\0' + workspaceId).digest('hex'), membershipVerified: true } }
}
