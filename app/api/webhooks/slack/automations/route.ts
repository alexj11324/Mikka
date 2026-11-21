import { withRequestLog } from '@/lib/request-log'
import { handleSlackAutomations } from '@/lib/slack/automation-route'


/** Slack events for 自动化 Slack triggers, forwarded by Eve; lib/slack/automation-route.ts. */
async function handlePOST(request: Request) {
  return handleSlackAutomations(request)
}

export const POST = withRequestLog('/api/webhooks/slack/automations', handlePOST)
