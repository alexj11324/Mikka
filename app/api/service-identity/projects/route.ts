import { governanceResponse } from '@/lib/governance/http'
import { listServiceCredentialProjects } from '@/lib/governance/service-credentials'

export const runtime = 'nodejs'
export const GET = (request: Request) => governanceResponse(async () => {
  const result = await listServiceCredentialProjects(request.headers.get('authorization'), new URL(request.url).searchParams.get('after'))
  return result ?? Response.json({ error: 'authRequired' }, { status: 401, headers: { 'cache-control': 'private, no-store' } })
})
