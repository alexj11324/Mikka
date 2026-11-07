import { pool } from '@/lib/db'
import { cloudClient } from '@/lib/cloud-services/runtime'
import { createCloudGitHubReceiver } from '@/lib/github/cloud-webhook'
import { dispatchVerifiedGitHubWebhook, readGitHubWebhookBody } from '@/lib/github/webhook-dispatch'
import { withRequestLog } from '@/lib/request-log'

export const runtime = 'nodejs'
const receive = createCloudGitHubReceiver({ database: pool, registration: () => cloudClient.registration(), readBody: readGitHubWebhookBody, dispatch: dispatchVerifiedGitHubWebhook })
export const POST = withRequestLog('/api/cloud/webhooks/github', async (request: Request) => {
  try { return await receive(request) }
  catch (error) {
    console.error(JSON.stringify({ event: 'cloud_github_webhook_failed', causeName: error instanceof Error ? error.name : 'unknown' }))
    return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
})
