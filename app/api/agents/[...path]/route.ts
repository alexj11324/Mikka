import { proxyEveRequest } from '@/lib/eve-service-proxy'

export const maxDuration = 800

export const GET = (request: Request) => proxyEveRequest(request)
export const POST = (request: Request) => proxyEveRequest(request)
export const OPTIONS = (request: Request) => proxyEveRequest(request)
