import { appendAudit } from '@/lib/audit/store'
import 'server-only'
import { Pool } from 'pg'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { appOrigin } from '@/lib/mcp/resource'
import { CredentialBroker } from './broker'
import { CredentialError } from './contracts'
import { PostgresCredentialAuthority } from './authority'
import { InfisicalCredentialVault } from './vault'
import { universalAuthTokenProvider } from './universal-auth'
import { credentialServices } from './services'
import { credentialHttp } from './http'
import { OwnedChromiumExecutor, type OwnedBrowserPolicy } from './owned-chromium'
import { CredentialExecutionTools, type CredentialToolActor, type CredentialToolName } from './execution-tools'

const globalRuntime = globalThis as unknown as { mikkaCredentials?: {
  broker?: CredentialBroker; cleanupBroker?: CredentialBroker; workspace?: Pool;
  browser?: OwnedChromiumExecutor; tools?: CredentialExecutionTools; timer?: ReturnType<typeof setInterval>
} }
const state = globalRuntime.mikkaCredentials ??= {}
function workspacePool() {
  return state.workspace ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 })
}
function browserExecutor() {
  if (state.browser) return state.browser
  if (process.env.MIKKA_CREDENTIAL_BROWSER_RUNNER !== 'owned') return undefined
  // Stateful browser ownership cannot be claimed inside independently scaled serverless lambdas.
  if (process.env.VERCEL || process.env.MIKKA_CREDENTIAL_RUNTIME_KIND !== 'dedicated') throw new CredentialError('browser_dedicated_runner_required', 503)
  const loopbackFixture = process.env.MIKKA_CREDENTIAL_BROWSER_LOOPBACK_FIXTURE === '1'
  if (loopbackFixture && (process.env.NODE_ENV === 'production' || process.env.CI !== 'true' || !['127.0.0.1', 'localhost'].includes(new URL(appOrigin!).hostname))) throw new CredentialError('browser_fixture_forbidden', 503)
  let policies: OwnedBrowserPolicy[]
  try { policies = JSON.parse(process.env.MIKKA_CREDENTIAL_BROWSER_POLICIES ?? '[]'); if (!Array.isArray(policies)) throw new Error() }
  catch { throw new CredentialError('browser_policy_invalid', 503) }
  state.browser = new OwnedChromiumExecutor({ executablePath: process.env.MIKKA_CREDENTIAL_CHROMIUM_PATH ?? '/usr/bin/chromium', policies, loopbackFixture })
  if (!state.timer) {
    state.timer = setInterval(() => { void getCredentialCleanupBroker().sweep().catch(() => {}) }, 5000)
    state.timer.unref()
  }
  return state.browser
}
function buildBroker(cleanupOnly: boolean) {
  const universal = cleanupOnly && process.env.MIKKA_CREDENTIAL_CLEANUP_AUTH === 'universal'
  if (!appOrigin || !process.env.DATABASE_URL || (!universal && !process.env.MIKKA_CREDENTIAL_VAULT_TOKEN)) throw new CredentialError('credential_configuration_missing', 503)
  const tokenProvider = universal ? universalAuthTokenProvider({
    origin: process.env.MIKKA_CREDENTIAL_VAULT_ORIGIN ?? 'https://us.infisical.com',
    credentials: () => process.env.MIKKA_CREDENTIAL_CLEANUP_AUTH === 'universal' ? {
      clientId: process.env.MIKKA_CREDENTIAL_CLEANUP_CLIENT_ID ?? '',
      clientSecret: process.env.MIKKA_CREDENTIAL_CLEANUP_CLIENT_SECRET ?? '',
    } : undefined,
  }) : undefined
  return new CredentialBroker({
    pool, authority: new PostgresCredentialAuthority(pool, workspacePool()),
    // Cleanup never provisions a browser or depends on its admission configuration.
    // A getter also sees an owned session created after this cleanup broker was cached.
    get browser() { return cleanupOnly ? state.browser : browserExecutor() },
    services: cleanupOnly ? new Map() : credentialServices(process.env.MIKKA_CREDENTIAL_SERVICES),
    vault: new InfisicalCredentialVault({
      origin: process.env.MIKKA_CREDENTIAL_VAULT_ORIGIN ?? 'https://us.infisical.com',
      projectId: process.env.MIKKA_CREDENTIAL_VAULT_PROJECT_ID ?? '',
      environment: process.env.MIKKA_CREDENTIAL_VAULT_ENVIRONMENT ?? '',
      secretPath: process.env.MIKKA_CREDENTIAL_VAULT_PATH ?? '',
      rejectAccessToken: tokenProvider?.rejectAccessToken,
      accessToken: async () => {
        if (tokenProvider) return tokenProvider.getAccessToken()
        const token = process.env.MIKKA_CREDENTIAL_VAULT_TOKEN
        if (!token) throw new CredentialError('vault_unavailable', 503)
        return token
      },
    }),
    notifyReady: async (binding, reference, serviceId) => {
      // Durable existing daemon input queue. Retries dedupe by request id; no secret/nonce/session token.
      await pool.query(`INSERT INTO run_messages (id,"runId","userId",text)
        SELECT id,run_id,owner_id,$4 FROM credential_requests WHERE id=$1 AND run_id=$2 AND owner_id=$3 AND state='ready'
        ON CONFLICT (id) DO NOTHING`,
        [reference, binding.runId, binding.ownerId, `Credential ready: ${reference}; service: ${serviceId}. Use credential_status and credential_use; never request plaintext.`])
    },
  })
}

export function getCredentialBroker() {
  // Enable only after ingress body capture and APM instrumentation are disabled for these routes.
  if (process.env.MIKKA_CREDENTIAL_BROKER_ENABLED !== '1' || process.env.MIKKA_CREDENTIAL_INGRESS_NO_BODY_CAPTURE !== '1') throw new CredentialError('credential_broker_disabled', 503)
  return state.broker ??= buildBroker(false)
}

/** Disabling admission must never disable orphan/expiry cleanup. */
export function getCredentialCleanupBroker() { return state.cleanupBroker ??= buildBroker(true) }

export async function executeSystemCredentialTool(actor: CredentialToolActor, name: CredentialToolName, input: unknown) {
  try {
    state.tools ??= new CredentialExecutionTools({ app: pool, workspace: workspacePool(), broker: getCredentialBroker(), basePath: process.env.MIKKA_BASE_PATH ?? '/mikka' })
    // Check enable flags on every call, including an already initialized executor.
    getCredentialBroker()
    return await state.tools.execute(actor, name, input)
  } catch (error) { return { error: error instanceof CredentialError ? error.code : 'credential_unavailable' } }
}

export async function handleCredentialRequest(request: Request, action: 'create' | 'get' | 'submit' | 'cancel' | 'events', id?: string) {
  try {
    return await credentialHttp({
      broker: ['get', 'events', 'cancel'].includes(action) ? getCredentialCleanupBroker() : getCredentialBroker(), origin: appOrigin!,
      denied: async (principal, reason) => { await appendAudit(pool, `personal:${principal.ownerId}`, { actorId: principal.ownerId, actorType: 'human', resourceId: 'credential', action: 'authorization.denied', outcome: 'denied', reason }) },
      authenticate: async req => {
        const session = await auth.api.getSession({ headers: req.headers })
        return session?.user && session.session.id ? { ownerId: session.user.id, authSessionId: session.session.id } : null
      },
    })(request, action, id)
  } catch (error) {
    return Response.json({ error: error instanceof CredentialError ? error.code : 'credential_unavailable' }, {
      status: 503, headers: { 'Cache-Control': 'private, no-store' },
    })
  }
}
