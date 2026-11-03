/** How long 停止 may take before the chat says it did not stop (Figma 843:2, usability review). */
export const STOP_CAP_MS = 10_000

/** Sends a stop and waits at most `cap` ms: true when the server took it in time, false when it failed or took too long. */
export async function stopWithin(request: () => Promise<unknown>, cap = STOP_CAP_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), cap) })
  try {
    return await Promise.race([request().then(() => true as const, () => false as const), late])
  } finally {
    clearTimeout(timer)
  }
}

/** A stop the person asked for: when, and whether its request failed. */
export interface StopAttempt { at: number; failed: boolean }

/** 「没停下 · 重试」: the stop request failed, or the reply is still working `cap` ms after it. */
export function stopStuck(attempt: StopAttempt | null, working: boolean, now: number, cap = STOP_CAP_MS): boolean {
  if (!attempt || !working) return false
  return attempt.failed || now - attempt.at >= cap
}

/**
 * A thread's composer button is stop only while the agent is generating or running.
 * A thread waiting for your answer is live but sends; stop moves to the bar (usability review N1).
 * A server too old to say `working` gets send: stopping by mistake is the worse error.
 */
export function composerStops(detail: { active: boolean; working?: boolean }): boolean {
  return detail.active && detail.working === true
}
