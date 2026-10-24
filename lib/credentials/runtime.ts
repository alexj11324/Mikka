import 'server-only'
import { Pool } from 'pg'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { appOrigin } from '@/lib/mcp/resource'
import { CredentialBroker } from './broker'
import { CredentialError } from './contracts'
import { PostgresCredentialAuthority } from './authority'
import { InfisicalCredentialVault } from './vault'
import { credentialServices } from './services'
import { credentialHttp } from './http'

let broker: CredentialBroker | undefined
let cleanupBroker: CredentialBroker | undefined
function buildBroker(cleanupOnly: boolean) {
  if (!appOrigin || !process.env.DATABASE_URL || !process.env.MIKKA_CREDENTIAL_VAULT_TOKEN) throw new CredentialError('credential_configuration_missing', 503)
  const workspace = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 })
  return new CredentialBroker({
    pool, authority: new PostgresCredentialAuthority(pool, workspace),
    services: cleanupOnly ? new Map() : credentialServices(process.env.MIKKA_CREDENTIAL_SERVICES),
    vault: new InfisicalCredentialVault({
      origin: process.env.MIKKA_CREDENTIAL_VAULT_ORIGIN ?? 'https://us.infisical.com',
      projectId: process.env.MIKKA_CREDENTIAL_VAULT_PROJECT_ID ?? '',
      environment: process.env.MIKKA_CREDENTIAL_VAULT_ENVIRONMENT ?? '',
      secretPath: process.env.MIKKA_CREDENTIAL_VAULT_PATH ?? '',
      accessToken: async () => {
        const token = process.env.MIKKA_CREDENTIAL_VAULT_TOKEN
        if (!token) throw new CredentialError('vault_unavailable', 503)
        return token
      },
    }),
  })
}

export function getCredentialBroker() {
  // Enable only after ingress body capture and APM instrumentation are disabled for these routes.
  if (process.env.MIKKA_CREDENTIAL_BROKER_ENABLED !== '1' || process.env.MIKKA_CREDENTIAL_INGRESS_NO_BODY_CAPTURE !== '1') throw new CredentialError('credential_broker_disabled', 503)
  return broker ??= buildBroker(false)
}

/** Disabling admission must never disable orphan/expiry cleanup. */
export function getCredentialCleanupBroker() { return cleanupBroker ??= buildBroker(true) }

export async function handleCredentialRequest(request: Request, action: 'create' | 'get' | 'submit' | 'cancel' | 'events', id?: string) {
  try {
    return await credentialHttp({
      broker: getCredentialBroker(), origin: appOrigin!,
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
