/**
 * The Coordinator's model, through Vercel AI Gateway. On Vercel the gateway
 * signs in with the deployment's OIDC token; elsewhere set AI_GATEWAY_API_KEY.
 */
export const COORDINATOR_MODEL = 'deepseek/deepseek-v4.1-flash-1017'

/** Tool-call rounds the Coordinator may take to answer one batch of messages. */
export const COORDINATOR_MAX_STEPS = 20

/**
 * Tools are off for the last allowed step, so a turn that runs out of steps
 * still ends with a reply instead of a tool call nobody answers.
 */
export function coordinatorStep({ stepNumber }: { stepNumber: number }): { toolChoice?: 'none' } {
  return stepNumber >= COORDINATOR_MAX_STEPS - 1 ? { toolChoice: 'none' } : {}
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
