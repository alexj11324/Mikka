import { roundStep } from '@/lib/agent-rounds'

/**
 * The default model (Mikka 默认): the Coordinator's, and the one behind action
 * titles, profile facts and group replies. It is called directly on ZeroCat's
 * OpenAI-compatible API (`deepseek-v4.1-flash`, lib/abuse/zerocat.ts), with
 * ZEROCAT_BASE_URL and ZEROCAT_API_KEY from Infisical `prod:/vercel`; without
 * them a call refuses as temporarily unavailable and never falls back to AI
 * Gateway. Other hosted model ids keep their Gateway route.
 */
// User-selected project default. Existing immutable run snapshots still resolve
// their own saved selection; changing this constant cannot rewrite their model.
// This id names the model inside Mikka (snapshots, ledger, admission rules).
export const COORDINATOR_MODEL = 'deepseek/deepseek-v4.1-flash'

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
