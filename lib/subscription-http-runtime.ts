import 'server-only'
import { auth } from './auth'
import type { SubscriptionHTTPDependencies } from './subscription-http'
import { authorizeSubscriptionWorkspace, subscriptionRuntime } from './subscription-runtime'

export const subscriptionHTTPDependencies: SubscriptionHTTPDependencies = {
  session: async request => {
    const session = await auth.api.getSession({ headers: request.headers })
    return session ? { userId: session.user.id, sessionId: session.session.id } : null
  },
  workspace: authorizeSubscriptionWorkspace,
  service: custodyOnly => subscriptionRuntime(false, custodyOnly)
}
