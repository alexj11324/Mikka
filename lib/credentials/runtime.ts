import 'server-only'
import { getVercelOidcToken } from '@vercel/oidc'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { resolveSubagentBrowserTarget } from '@/lib/cloud-computer/subagent-browser'
import { canonicalOrigin, CredentialError, type BrowserCaller } from './contracts'
import { awsKms } from './kms'
import { CredentialStore } from './store'

export const credentialStore = new CredentialStore(pool, awsKms('app'))
export async function credentialActor(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) throw new CredentialError('credential_auth_required', 401)
  const context = await loadWorkspaceContext(undefined, session.user)
  return { userId: session.user.id, workspaceId: context.workspace.id }
}

export async function login(caller: BrowserCaller, site: string) {
  const origin = canonicalOrigin(site)
  await credentialStore.authorize(caller)
  const target = await resolveSubagentBrowserTarget(caller)
  const lease = await credentialStore.lease(caller, origin, target)
  if (lease.status === 'needs_login') return lease
  const broker = new URL(process.env.CREDENTIAL_BROKER_URL ?? '')
  if (broker.protocol !== 'https:' || !broker.hostname.endsWith('.vercel.app') || broker.pathname !== '/' || broker.username || broker.password || broker.search || broker.hash) throw new CredentialError()
  try {
    const response = await fetch(new URL('/api/fill', broker), { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${await getVercelOidcToken()}`,
      ...(process.env.CREDENTIAL_BROKER_PREVIEW_BYPASS ? { 'x-vercel-protection-bypass': process.env.CREDENTIAL_BROKER_PREVIEW_BYPASS } : {}),
    }, body: JSON.stringify({ lease: lease.lease }), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(40_000) })
    if (!response.ok) { await response.body?.cancel(); throw new Error() }
    // Do not forward arbitrary responses from another process to the model.
    const result = await response.json()
    if (result.status !== 'submitted' || result.origin !== origin) throw new Error()
    return { status: 'submitted' as const, origin }
  } catch { throw new CredentialError() }
}
