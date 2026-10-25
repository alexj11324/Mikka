import { subscriptionCallback } from '@/lib/subscription-http'
import { subscriptionHTTPDependencies } from '@/lib/subscription-http-runtime'

export const runtime = 'nodejs'
export const maxDuration = 60
export const GET = (request: Request) => subscriptionCallback(request, subscriptionHTTPDependencies)
