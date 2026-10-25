import { subscriptionVaultCredentials } from './subscription-vault-identity'
import { universalAuthTokenProvider } from './credentials/universal-auth'
export type SubscriptionVaultRole = 'custody' | 'access'
export interface SubscriptionVaultTokens {
  get(role: SubscriptionVaultRole): Promise<string>
  reject(role: SubscriptionVaultRole, token: string): void
}
// Longest worker request is275s plus bounded55s shutdown/publication. Tokens
// must remain valid through that window; each new IPC call obtains a fresh lease.
export function createSubscriptionVaultTokens(env: () => NodeJS.ProcessEnv, fetcher?: typeof fetch): SubscriptionVaultTokens {
  const origin = env().MIKKA_BYOS_INFISICAL_ORIGIN
  if (!origin) throw new Error('subscription_vault_configuration_invalid')
  const provider = (role: SubscriptionVaultRole) => universalAuthTokenProvider({
    origin, minimumValidityMs: 335000, fetch: fetcher,
    credentials: () => {
      const current = env()
      if (current.MIKKA_BYOS_VAULT_AUTH !== 'universal' || current.MIKKA_BYOS_INFISICAL_ORIGIN !== origin) return undefined
      return subscriptionVaultCredentials(current, role)
    }
  })
  const custody = provider('custody'), access = provider('access')
  return { get: role => (role === 'custody' ? custody : access).getAccessToken(),
    reject: (role, token) => (role === 'custody' ? custody : access).rejectAccessToken(token) }
}
let current: SubscriptionVaultTokens | undefined
export function subscriptionVaultTokens() { return current ??= createSubscriptionVaultTokens(() => process.env) }
