import 'server-only'
import { after } from 'next/server'
import { processLinearInboxDelivery, processLinearIssueOutbox, processLinearSyncBatch } from './worker'

export function dispatchLinearWork() {
  after(async () => {
    try { await processLinearSyncBatch() }
    catch { console.error('Linear background sync could not start') }
  })
}

export function dispatchLinearIssueSync(issueId: string) {
  after(async () => {
    try { await processLinearIssueOutbox(issueId) }
    catch { console.error('Linear background issue sync could not start') }
  })
}

export function dispatchLinearWebhook(deliveryId: string) {
  after(async () => {
    try { await processLinearInboxDelivery(deliveryId) }
    catch { console.error('Linear background webhook processing could not start') }
  })
}
