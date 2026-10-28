import 'server-only'
import { getVercelOidcToken } from '@vercel/oidc'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { resolveSubagentBrowserTarget, resolveThreadBrowserTarget } from '@/lib/cloud-computer/subagent-browser'
import { canonicalOrigin, CredentialError, type BrowserCaller } from './contracts'
import { awsKms } from './kms'
import { CredentialStore } from './store'

export const credentialStore = new CredentialStore(pool, awsKms('app'))
export async function credentialActor(request: Request) {
  if (process.env.CREDENTIAL_VAULT_ENABLED !== '1') throw new CredentialError()
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) throw new CredentialError('credential_auth_required', 401)
  const context = await loadWorkspaceContext(undefined, session.user)
  return { userId: session.user.id, workspaceId: context.workspace.id }
}

export async function login(caller: BrowserCaller, site: string, submittedUsername?: string, options?: { forcePassword?: boolean }) {
  if (process.env.CREDENTIAL_VAULT_ENABLED !== '1') throw new CredentialError()
  const origin = canonicalOrigin(site)
  await credentialStore.authorize(caller)
  const target = await resolveCredentialBrowser(caller)
  const lease = await credentialStore.lease(caller, origin, target, submittedUsername, options?.forcePassword)
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

async function brokerErrorCode(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4096) { await reader.cancel(); return null }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))?.error
  } catch { return null } finally { reader.releaseLock() }
}

export async function executeCredentialLease(lease: string, origin: string) {
  const broker = new URL(process.env.CREDENTIAL_BROKER_URL ?? '')
  if (broker.protocol !== 'https:' || !broker.hostname.endsWith('.vercel.app') || broker.pathname !== '/' || broker.username || broker.password || broker.search || broker.hash) throw new CredentialError()
  let dispatched = false, responseReceived = false
  try {
    const identity = await getVercelOidcToken()
    dispatched = true
    const response = await fetch(new URL('/api/fill', broker), { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${identity}`,
      ...(process.env.CREDENTIAL_BROKER_PREVIEW_BYPASS ? { 'x-vercel-protection-bypass': process.env.CREDENTIAL_BROKER_PREVIEW_BYPASS } : {}),
    }, body: JSON.stringify({ lease }), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(40_000) })
    responseReceived = true
    if (!response.ok) {
      if (response.status >= 500) { await response.body?.cancel(); throw new CredentialError('credential_outcome_unknown', 409) }
      if (response.status === 409) {
        if (await brokerErrorCode(response) === 'credential_outcome_unknown') throw new CredentialError('credential_outcome_unknown', 409)
      } else await response.body?.cancel()
      throw new Error()
    }
    // Do not forward arbitrary responses from another process to the model.
    const result = await response.json().catch(() => null)
    if (!result || !['submitted', 'session_applied', 'guarded'].includes(result.status) || result.origin !== origin) throw new CredentialError('credential_outcome_unknown', 409)
    return { status: result.status as 'submitted' | 'session_applied' | 'guarded', origin }
  } catch (error) {
    if (error instanceof CredentialError && error.code === 'credential_outcome_unknown') throw error
    if (dispatched && !responseReceived) throw new CredentialError('credential_outcome_unknown', 409)
    throw new CredentialError()
  }
}
