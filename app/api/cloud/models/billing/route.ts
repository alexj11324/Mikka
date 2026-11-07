import { withRequestLog } from '@/lib/request-log'
import { readServerSession } from '@/lib/server-admin'
import { isCloudEdition } from '@/lib/edition'
import { cloudModelBillingUrl } from '@/lib/cloud-services/model-billing'
import { CloudServiceError, cloudErrorStatus } from '@/lib/cloud-services/errors'
import { CLOUD_HEADERS } from '@/lib/cloud-services/http'

export const GET = withRequestLog('/api/cloud/models/billing', async (request: Request) => {
  if (isCloudEdition()) return Response.json({ error: 'cloud_access_denied' }, { status: 403, headers: CLOUD_HEADERS })
  const session = await readServerSession(request.headers)
  if (!session) return Response.json({ error: 'authRequired' }, { status: 401, headers: CLOUD_HEADERS })
  try {
    const url = await cloudModelBillingUrl(session.user.id)
    return new URL(request.url).searchParams.get('redirect') === '1'
      ? new Response(null, { status: 303, headers: { ...CLOUD_HEADERS, Location: url } })
      : Response.json({ url }, { headers: CLOUD_HEADERS })
  } catch (error) {
    if (error instanceof CloudServiceError) {
      const status = cloudErrorStatus(error.code)
      // The local session is valid. A revoked cloud grant cannot log a person
      // out of their self-hosted server (mobile reserves 401 for that session).
      return Response.json({ error: error.code }, { status: status === 401 ? 403 : status, headers: CLOUD_HEADERS })
    }
    throw error
  }
})
