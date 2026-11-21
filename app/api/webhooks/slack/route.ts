import { proxyEveRequest } from '@/lib/eve-service-proxy'

export const maxDuration = 60

export async function POST(request: Request) {
  return proxyEveRequest(request, '/eve/v1/slack')
}
