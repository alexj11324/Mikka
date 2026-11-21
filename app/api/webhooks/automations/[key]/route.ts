import { withRequestLog } from '@/lib/request-log'
import { handleAutomationWebhook } from '@/lib/schedules/webhook-route'


/** An automation's webhook URL; lib/schedules/webhook-route.ts. The key in the path is masked in traces. */
async function handlePOST(request: Request, { params }: { params: Promise<{ key: string }> }) {
  return handleAutomationWebhook(request, (await params).key)
}

export const POST = withRequestLog('/api/webhooks/automations/[key]', handlePOST)
