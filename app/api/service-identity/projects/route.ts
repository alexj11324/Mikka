import { governanceResponse } from '@/lib/governance/http'
import { readServiceCredentialProjects } from '@/lib/governance/service-credentials'

export const runtime = 'nodejs'
export const GET = (request: Request) => governanceResponse(async () => {
  const result = await readServiceCredentialProjects(request.headers.get('authorization'), { after: new URL(request.url).searchParams.get('after') })
  return result ?? Response.json({ error: 'authRequired' }, { status: 401, headers: { 'cache-control': 'private, no-store' } })
})
