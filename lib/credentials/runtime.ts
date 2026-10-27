import 'server-only'
import { getVercelOidcToken } from '@vercel/oidc'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { resolveSubagentBrowserTarget, resolveThreadBrowserTarget } from '@/lib/cloud-computer/subagent-browser'
import { canonicalOrigin, CredentialError, type BrowserCaller } from './contracts.js'
import { awsKms } from './kms.js'
import { CredentialStore } from './store.js'

export const credentialStore = new CredentialStore(pool, awsKms('app'))
export async function credentialActor(request: Request) {
  if (process.env.CREDENTIAL_VAULT_ENABLED !== '1') throw new CredentialError()
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) throw new CredentialError('credential_auth_required', 401)
  const context = await loadWorkspaceContext(undefined, session.user)
  return { userId: session.user.id, workspaceId: context.workspace.id }
}

export async function login(caller: BrowserCaller, site: string, submittedUsername?: string) {
  if (process.env.CREDENTIAL_VAULT_ENABLED !== '1') throw new CredentialError()
  const origin = canonicalOrigin(site)
  await credentialStore.authorize(caller)
  const target = await resolveCredentialBrowser(caller)
  const lease = await credentialStore.lease(caller, origin, target, submittedUsername)
  if (lease.status === 'needs_login') return lease
  return executeCredentialLease(lease.lease, origin)
}

export async function resolveCredentialBrowser(caller: BrowserCaller) {
  const target = caller.subagentId
    ? await resolveSubagentBrowserTarget({ ...caller, subagentId: caller.subagentId })
    : caller.runId ? await resolveThreadBrowserTarget({ ...caller, runId: caller.runId }) : null
  if (!target) throw new CredentialError('credential_denied', 404)
  return target
}

export async function executeCredentialLease(lease: string, origin: string) {
  const broker = new URL(process.env.CREDENTIAL_BROKER_URL ?? '')
  if (broker.protocol !== 'https:' || !broker.hostname.endsWith('.vercel.app') || broker.pathname !== '/' || broker.username || broker.password || broker.search || broker.hash) throw new CredentialError()
  try {
    const response = await fetch(new URL('/api/fill', broker), { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${await getVercelOidcToken()}`,
      ...(process.env.CREDENTIAL_BROKER_PREVIEW_BYPASS ? { 'x-vercel-protection-bypass': process.env.CREDENTIAL_BROKER_PREVIEW_BYPASS } : {}),
    }, body: JSON.stringify({ lease }), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(40_000) })
    if (!response.ok) { await response.body?.cancel(); throw new Error() }
    // Do not forward arbitrary responses from another process to the model.
    const result = await response.json()
    if (!['submitted', 'needs_code'].includes(result.status) || result.origin !== origin) throw new Error()
    return { status: result.status as 'submitted' | 'needs_code', origin }
  } catch { throw new CredentialError() }
}
