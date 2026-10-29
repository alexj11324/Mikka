import { subscriptionHTTP, subscriptionList } from '@/lib/subscription-http'
import { subscriptionHTTPDependencies } from '@/lib/subscription-http-runtime'

export const runtime = 'nodejs'
export const maxDuration = 60
export const POST = subscriptionHTTP(subscriptionHTTPDependencies)
export const GET = (request: Request) => subscriptionList(request, subscriptionHTTPDependencies)
