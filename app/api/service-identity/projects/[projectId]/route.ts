import { governanceResponse } from '@/lib/governance/http'
import { readServiceCredentialProjects } from '@/lib/governance/service-credentials'

export const runtime = 'nodejs'
type Context = { params: Promise<{ projectId: string }> }

export const GET = (request: Request, { params }: Context) => governanceResponse(async () => {
  const result = await readServiceCredentialProjects(request.headers.get('authorization'), await params)
  return result ?? Response.json({ error: 'authRequired' }, { status: 401, headers: { 'cache-control': 'private, no-store' } })
})
