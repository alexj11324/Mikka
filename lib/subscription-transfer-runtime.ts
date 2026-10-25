import { subscriptionVaultCredentials } from './subscription-vault-identity'
import 'server-only'
import { subscriptionTransferApproval } from './subscription-transfer-contract'
import { universalAuthTokenProvider } from './credentials/universal-auth'

let sourceTokens: ReturnType<typeof universalAuthTokenProvider> | undefined
// Separate source cache and logical role, even with explicit shared identity.
// No user/model-supplied vault target is accepted.
export function enrollmentTransferConfiguration(runtimeOrigin: string) {
  const encoded = process.env.MIKKA_BYOS_TRANSFER_APPROVAL
  if (!encoded) return {}
  const transferApproval = subscriptionTransferApproval.parse(JSON.parse(encoded))
  if (runtimeOrigin !== transferApproval.destinationOrigin || process.env.MIKKA_BYOS_INFISICAL_ORIGIN !== transferApproval.destination.origin || process.env.MIKKA_BYOS_INFISICAL_PROJECT !== transferApproval.destination.projectId || process.env.MIKKA_BYOS_INFISICAL_ENVIRONMENT !== 'prod') throw new Error('subscription_transfer_unavailable')
  sourceTokens ??= universalAuthTokenProvider({
    origin: 'https://app.infisical.com', minimumValidityMs: 105_000,
    credentials: () => {
      if (process.env.MIKKA_BYOS_INFISICAL_ORIGIN !== 'https://app.infisical.com') return undefined
      return subscriptionVaultCredentials(process.env, 'source')
    },
  })
  return { transferApproval, runtimeOrigin, sourceTokens }
}
