import { freshSessionRoute } from '@/lib/fresh-session'
import { withRequestLog } from '@/lib/request-log'
import { subscriptionHTTP, subscriptionList } from '@/lib/subscription-http'
import { subscriptionHTTPDependencies } from '@/lib/subscription-http-runtime'

export const runtime = 'nodejs'
export const maxDuration = 60
const POSTBody = withRequestLog('/api/subscriptions', subscriptionHTTP(subscriptionHTTPDependencies))
export const GET = withRequestLog('/api/subscriptions', (request: Request) => subscriptionList(request, subscriptionHTTPDependencies))

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(POSTBody)
