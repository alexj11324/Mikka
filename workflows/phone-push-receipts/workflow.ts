import { sleep } from 'workflow'
import { checkReceipts } from './steps'

/** Event-driven receipt verification; notification content is never a Workflow argument. */
export async function phonePushReceipts(deliveryId: string) {
  'use workflow'
  await sleep('15m')
  if (await checkReceipts(deliveryId, false)) {
    await sleep('45m')
    await checkReceipts(deliveryId, true)
  }
}
