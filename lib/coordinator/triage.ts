import type { CoordinatorEventKind, CoordinatorEventTier } from '@/lib/db/schema'

// How much an event matters, decided before the Coordinator sees it. Clear
// cases follow fixed rules; the rest go to a decision model (Cloudflare's
// Clef), which answers a typed question with a probability instead of
// writing text.

/** The decision model on Workers AI. */
export const TRIAGE_MODEL = 'clef'
/** At or above this probability, a finished run needs the person. */
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
  }
}

/** What the decision model reads about a finished run. */
export function triageState(event: TriageEvent) {
  return { status: String(event.payload.status), stopReason: String(event.payload.stopReason), agentSummary: String(event.payload.summary ?? '').slice(0, 4000) }
}

export const TRIAGE_QUESTIONS = {
  needsPerson: {
    type: 'noul',
    instructions: 'A coding agent finished a run and wrote this summary. Does the person need to look at it themselves: the agent says it could not finish or could not verify its work, hit a blocker, made a risky or surprising change, or is waiting for a decision?',
  },
} as const

/** The tier for a finished run from the model's probability that it needs the person. */
export function tierFromDecision(needsPerson: number): CoordinatorEventTier {
  return needsPerson >= ATTENTION_THRESHOLD ? 'attention' : 'result'
}
