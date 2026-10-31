import { withRequestLog } from '@/lib/request-log'
import { subscriptionHTTP, subscriptionList } from '@/lib/subscription-http'
import { subscriptionHTTPDependencies } from '@/lib/subscription-http-runtime'

export const runtime = 'nodejs'
export const maxDuration = 60
export const POST = withRequestLog('/api/subscriptions', subscriptionHTTP(subscriptionHTTPDependencies))
export const GET = withRequestLog('/api/subscriptions', (request: Request) => subscriptionList(request, subscriptionHTTPDependencies))
