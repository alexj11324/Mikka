import { roundStep } from '@/lib/agent-rounds'

/**
 * The Coordinator's model, through Vercel AI Gateway. On Vercel the gateway
 * signs in with the deployment's OIDC token; elsewhere set AI_GATEWAY_API_KEY.
 */
export const COORDINATOR_MODEL = 'minimax/minimax-m3.1-flash'

/**
 * Settings for the Coordinator's next step under the shared round cap
 * (lib/agent-rounds.ts): the round notice rides on the instructions, and the
 * last round has tools off so the turn still ends with a reply.
 */
export function coordinatorStep({ stepNumber, initialInstructions }: { stepNumber: number; initialInstructions?: unknown }): { toolChoice?: 'none'; system?: string } {
  const { toolChoice, instructions } = roundStep(stepNumber, typeof initialInstructions === 'string' ? initialInstructions : '')
  return { ...(toolChoice ? { toolChoice } : {}), ...(instructions && typeof initialInstructions === 'string' ? { system: instructions } : {}) }
}

/**
 * Why a finished turn's reply may be cut short, for the chat to show, or null
 * when it ended normally with text.
 */
export function turnWarning(finishReason: string, text: string): string | null {
  if (finishReason === 'length') return 'replyCutOff: the model hit its output limit'
  if (finishReason === 'content-filter') return 'replyFiltered: the provider filtered the reply'
  if (finishReason === 'error' || finishReason === 'other') return `replyEndedEarly: finish reason ${finishReason}`
  if (!text.trim()) return 'replyEmpty: the model returned no text'
  return null
}
