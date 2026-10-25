import 'server-only'
import { subscriptionTransferApproval } from './subscription-transfer-contract'
import { universalAuthTokenProvider } from './credentials/universal-auth'

let sourceTokens: ReturnType<typeof universalAuthTokenProvider> | undefined
// Separate, temporary source role: not the cleanup identity, runtime reader or
// destination custody identity. No user/model-supplied vault target is accepted.
export function enrollmentTransferConfiguration(runtimeOrigin: string) {
  const encoded = process.env.MIKKA_BYOS_TRANSFER_APPROVAL
  if (!encoded) return {}
  const transferApproval = subscriptionTransferApproval.parse(JSON.parse(encoded))
  if (runtimeOrigin !== transferApproval.destinationOrigin || process.env.MIKKA_BYOS_INFISICAL_ORIGIN !== transferApproval.destination.origin || process.env.MIKKA_BYOS_INFISICAL_PROJECT !== transferApproval.destination.projectId || process.env.MIKKA_BYOS_INFISICAL_ENVIRONMENT !== 'prod') throw new Error('subscription_transfer_unavailable')
  sourceTokens ??= universalAuthTokenProvider({
    origin: 'https://app.infisical.com', minimumValidityMs: 105_000,
    credentials: () => {
      const clientId = process.env.MIKKA_BYOS_TRANSFER_SOURCE_CLIENT_ID
      const clientSecret = process.env.MIKKA_BYOS_TRANSFER_SOURCE_CLIENT_SECRET
      if (!clientId || !clientSecret || process.env.MIKKA_BYOS_INFISICAL_ORIGIN !== 'https://app.infisical.com' || [process.env.MIKKA_BYOS_CUSTODY_CLIENT_ID, process.env.MIKKA_BYOS_ACCESS_CLIENT_ID].includes(clientId)) return undefined
      return { clientId, clientSecret }
    },
  })
  return { transferApproval, runtimeOrigin, sourceTokens }
}
