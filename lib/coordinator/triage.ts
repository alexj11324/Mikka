import type { CoordinatorEventKind, CoordinatorEventTier } from '@/lib/db/schema'

// How much an event matters, decided before the Coordinator sees it. Clear
// cases follow fixed rules; the rest go to a decision model (Cloudflare's
// Clef), which answers a typed question with a probability instead of
// writing text.

/** The decision model on Workers AI. */
export const TRIAGE_MODEL = 'clef'
/** At or above this probability, an event needs the person. */
export const ATTENTION_THRESHOLD = 0.5

interface TriageEvent { kind: CoordinatorEventKind; payload: Record<string, unknown> }

/** The tier fixed rules give, or null when the decision model should judge. */
export function ruleTier(event: TriageEvent): CoordinatorEventTier | null {
  switch (event.kind) {
    case 'user_message':
      return 'attention'
    case 'issue_done':
      return 'background'
    case 'run_finished':
      if (event.payload.status === 'failed') return 'attention'
      if (event.payload.status === 'stopped' || event.payload.status === 'cancelled') return 'background'
      // A success that says nothing needs no judgment.
      return typeof event.payload.summary === 'string' && event.payload.summary.trim() ? null : 'result'
    // An agent that asks or is stuck waits on the person.
    case 'run_question':
    case 'run_blocked':
      return 'attention'
    // A progress note is background unless the decision model sees something in it.
    case 'run_report':
      return typeof event.payload.text === 'string' && event.payload.text.trim() ? null : 'background'
  }
}

/** What the decision model reads about an event the rules left open. */
export function triageState(event: TriageEvent) {
  if (event.kind === 'run_report') return { agentProgressNote: String(event.payload.text ?? '').slice(0, 4000) }
  return { status: String(event.payload.status), stopReason: String(event.payload.stopReason), agentSummary: String(event.payload.summary ?? '').slice(0, 4000) }
}

const FINISHED_QUESTION = 'A coding agent finished a run and wrote this summary. Does the person need to look at it themselves: the agent says it could not finish or could not verify its work, hit a blocker, made a risky or surprising change, or is waiting for a decision?'
const REPORT_QUESTION = 'A coding agent is still working and sent this progress note. Does the person need to hear about it now, rather than with the final result: it changes the plan or scope, touches something risky (data, schema, auth, billing, production, deleting things), reports a problem or a surprising finding, or hints that it will need a decision?'

/** The question the decision model answers, always under the key `needsPerson`. */
export function triageQuestions(event: TriageEvent) {
  return { needsPerson: { type: 'noul', instructions: event.kind === 'run_report' ? REPORT_QUESTION : FINISHED_QUESTION } } as const
}

/** The tier from the model's probability that the event needs the person. Below the threshold a finished run is a result and a progress note stays background. */
export function tierFromDecision(needsPerson: number, kind: CoordinatorEventKind = 'run_finished'): CoordinatorEventTier {
  if (needsPerson >= ATTENTION_THRESHOLD) return 'attention'
  return kind === 'run_report' ? 'background' : 'result'
}

/** Keeps waking events in the next batch while showing selected events chronologically. */
export function eventsForInbox<T extends { createdAt: Date }>(waking: readonly T[], background: readonly T[], limit: number): T[] {
  return [...waking.slice(0, limit), ...background.slice(0, Math.max(0, limit - waking.length))]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}
