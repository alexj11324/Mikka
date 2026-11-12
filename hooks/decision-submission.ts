export type DecisionReceipt =
  | { status: 'accepted' }
  | { status: 'failed' | 'unavailable' | 'uncertain'; error: string }
export type DecisionState = { status: 'idle' | 'submitting' } | DecisionReceipt

const idle = { status: 'idle' } as const

/** One acknowledgement lifecycle for reply choices, Factory decisions and Inbox actions. */
export function createDecisionSubmission(update: () => void) {
  const states = new Map<string, DecisionState>()
  function state(key: string): DecisionState {
    return states.get(key) ?? idle
  }
  async function submit(key: string, write: () => Promise<DecisionReceipt>, onError: string): Promise<boolean> {
    const previous = state(key).status
    if (previous === 'submitting' || previous === 'accepted' || previous === 'unavailable') return false
    states.set(key, { status: 'submitting' })
    update()
    let receipt: DecisionReceipt
    try {
      receipt = await write()
    } catch {
      receipt = { status: 'uncertain', error: onError }
    }
    states.set(key, receipt)
    update()
    return receipt.status === 'accepted'
  }
  return { state, submit }
}
