import { subscriptionUsage } from '@/lib/subscription-http'
import { subscriptionHTTPDependencies } from '@/lib/subscription-http-runtime'

export const runtime = 'nodejs'
export const maxDuration = 30
export const GET = (request: Request) => subscriptionUsage(request, subscriptionHTTPDependencies)
