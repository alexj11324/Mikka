import 'server-only'
import { Pool } from 'pg'
import { pool } from '@/lib/db'
import { CredentialBroker } from './broker'
import { PostgresCredentialAuthority } from './authority'
import { CredentialError } from './contracts'
import { InfisicalCredentialVault } from './vault'
import { universalAuthTokenProvider } from './universal-auth'

// Compatibility release: cleanup only. No admission route, browser, tool or
// service registry is installed by this composition.
const state = globalThis as unknown as { mikkaCleanupCompatibility?: CredentialBroker }
export function getCredentialCleanupBroker() {
  if (process.env.MIKKA_CREDENTIAL_CLEANUP_AUTH !== 'universal' || !process.env.DATABASE_URL) {
    throw new CredentialError('credential_configuration_missing', 503)
  }
  if (state.mikkaCleanupCompatibility) return state.mikkaCleanupCompatibility
  const origin = process.env.MIKKA_CREDENTIAL_VAULT_ORIGIN ?? 'https://us.infisical.com'
  const tokens = universalAuthTokenProvider({ origin,
    onFailure: failure => console.warn('credential_cleanup_auth_failure', failure),
    credentials: () =>
    process.env.MIKKA_CREDENTIAL_CLEANUP_AUTH === 'universal' ? {
      clientId: process.env.MIKKA_CREDENTIAL_CLEANUP_CLIENT_ID ?? '',
      clientSecret: process.env.MIKKA_CREDENTIAL_CLEANUP_CLIENT_SECRET ?? '',
    } : undefined,
  })
  const vault = new InfisicalCredentialVault({
    origin, projectId: process.env.MIKKA_CREDENTIAL_VAULT_PROJECT_ID ?? '',
    environment: process.env.MIKKA_CREDENTIAL_VAULT_ENVIRONMENT ?? '',
    secretPath: process.env.MIKKA_CREDENTIAL_VAULT_PATH ?? '',
    accessToken: () => tokens.getAccessToken(), rejectAccessToken: tokens.rejectAccessToken,
    onFailure: failure => console.warn('credential_cleanup_vault_failure', failure),
  })
  const workspace = new Pool({ connectionString: process.env.DATABASE_URL, max: 2,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 })
  return state.mikkaCleanupCompatibility = new CredentialBroker({
    pool, vault, authority: new PostgresCredentialAuthority(pool, workspace), services: new Map(),
  })
}
