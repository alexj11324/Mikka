import { RetryableError } from 'workflow'

export async function checkReceipts(deliveryId: string, final: boolean): Promise<boolean> {
  'use step'
  const { checkPhonePushReceipts } = await import('@/lib/mobile-push-delivery')
  try { return await checkPhonePushReceipts(deliveryId, final) }
  catch (error) {
    const retry = new RetryableError('Push receipt check is temporarily unavailable.', { retryAfter: '2m' })
    retry.cause = error
    throw retry
  }
}
checkReceipts.maxRetries = 3
