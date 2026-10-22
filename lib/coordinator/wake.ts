import 'server-only'
import { start } from 'workflow/api'
import { coordinatorTurn } from '@/workflows/coordinator/workflow'

/**
 * Whether the Coordinator runs here: on Vercel (the AI Gateway signs in with
 * the deployment's OIDC token) or wherever a gateway key is set. Elsewhere,
 * events still collect in the inbox and wait.
 */
export function coordinatorEnabled(): boolean {
  return process.env.VERCEL === '1' || Boolean(process.env.AI_GATEWAY_API_KEY)
}

/**
 * Starts a Coordinator turn for this person. Call it after the event is
 * committed. Never throws: an event whose wake fails waits for the next one.
 */
export async function wakeCoordinator(userId: string): Promise<void> {
  if (!coordinatorEnabled()) return
  try {
    await start(coordinatorTurn, [userId])
  } catch (error) {
    console.error('Failed to wake the Coordinator', error instanceof Error ? error.message : error)
  }
}
