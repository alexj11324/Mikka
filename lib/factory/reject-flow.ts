/** The "send back for changes" note (Figma F5/F6/M2). Pure so every transition is testable. */
export type RejectPhase = 'closed' | 'editing' | 'submitting' | 'failed'
export type RejectFlow = { phase: RejectPhase; note: string }
export type RejectEvent =
  | { type: 'open' }
  | { type: 'edit'; note: string }
  | { type: 'submit' }
  | { type: 'fail' }
  | { type: 'succeed' }
  | { type: 'cancel' }

export const closedReject: RejectFlow = { phase: 'closed', note: '' }

/** A note can be sent while editing or after a failure, and only with text. */
export const canSubmitReject = (flow: RejectFlow) => (flow.phase === 'editing' || flow.phase === 'failed') && flow.note.trim().length > 0

export function rejectFlow(flow: RejectFlow, event: RejectEvent): RejectFlow {
  switch (event.type) {
    case 'open': return flow.phase === 'closed' ? { phase: 'editing', note: '' } : flow
    // The note is frozen while it is being sent.
    case 'edit': return flow.phase === 'editing' || flow.phase === 'failed' ? { ...flow, note: event.note } : flow
    case 'submit': return canSubmitReject(flow) ? { ...flow, phase: 'submitting' } : flow
    // A failure keeps the note so it can be resent as is.
    case 'fail': return flow.phase === 'submitting' ? { ...flow, phase: 'failed' } : flow
    case 'succeed': return flow.phase === 'submitting' ? closedReject : flow
    // A send in flight cannot be cancelled.
    case 'cancel': return flow.phase === 'submitting' ? flow : closedReject
  }
}

/** Reject is offered only while the candidate waits for a decision and the server says it can take one. */
export const canReject = (state: string, supported: boolean) => supported && state === 'pending'
