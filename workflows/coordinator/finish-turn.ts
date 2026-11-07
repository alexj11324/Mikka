import { releaseLease } from '@/lib/coordinator/store'

/** The bounded Workflow has no next iteration to take input that arrived
 * during its last round. Release the committed lease before starting a new
 * wake; the existing inbox claim and deadline own its delivery and retries. */
export async function finishCoordinatorTurn(userId: string, holder: string, botId: string) {
  'use step'
  if (await releaseLease(userId, holder, botId)) {
    const { wakeCoordinator } = await import('@/lib/coordinator/wake')
    await wakeCoordinator(userId)
  }
}
