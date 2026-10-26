// i18n-ignore-file: The round notice is a model instruction, not UI copy.

/**
 * One WorkflowAgent.generate / inbox batch may use at most this many model
 * calls. A new generate call resets the counter; this is not a durable counter
 * keyed by user-message identity. Tool results do not reset it. Web searches
 * have no separate per-message four-call counter in the current Bot harness.
 */
export const AGENT_MAX_ROUNDS = 120

/** From here on the model is told how many rounds remain and asked to finish: three quarters of the cap. */
export const ROUND_WARNING_LINE = AGENT_MAX_ROUNDS - Math.max(Math.floor(AGENT_MAX_ROUNDS / 4), 1)

/** What the model is told once it has used `round` rounds on this message, or null below the warning line. */
export function roundNotice(round: number): string | null {
  if (round < ROUND_WARNING_LINE) return null
  const remaining = Math.max(AGENT_MAX_ROUNDS - round, 0)
  return `这条消息已经用了 ${round} 轮模型调用，上限 ${AGENT_MAX_ROUNDS} 轮，还剩 ${remaining} 轮。现在收尾：把已有的结果交给用户，或者说明卡在哪里，然后结束。不要再开始新的搜索、检查或等待。`
}

/**
 * Settings for the step about to run. Past the warning line the instructions
 * carry the notice; the last round has tools off, so the message still ends
 * with a reply instead of a tool call nobody answers.
 */
export function roundStep(stepNumber: number, instructions: string): { toolChoice?: 'none'; instructions?: string } {
  const notice = roundNotice(stepNumber)
  return {
    ...(stepNumber >= AGENT_MAX_ROUNDS - 1 ? { toolChoice: 'none' as const } : {}),
    ...(notice ? { instructions: `${instructions}\n\n${notice}` } : {}),
  }
}
