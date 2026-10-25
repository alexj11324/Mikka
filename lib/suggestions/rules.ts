import type { DecisionQuestion } from '@/lib/coordinator/decision'
import type { SuggestionDecider } from '@/lib/db/schema'
import type { ExternalNotification } from './notification'

// Whether a notification goes on the suggestions list. Clear cases follow
// fixed rules; the rest go to the decision model (lib/coordinator/decide.ts).
// When the model does not answer (no credentials, budget spent, failure), the
// fallback shows only what was addressed to the person. What is not shown is
// not shown anywhere: the person still has it in the source app.

/** At or above this probability, the model's answer puts it on the list. */
export const SHOW_THRESHOLD = 0.5

export interface Verdict { shown: boolean; decidedBy: SuggestionDecider; probability: number | null }

/** The verdict fixed rules give, or null when the decision model should judge. */
export function ruleVerdict(notification: ExternalNotification): Verdict | null {
  if (notification.fromSelf || notification.automated) return { shown: false, decidedBy: 'rule', probability: null }
  if (notification.required) return { shown: true, decidedBy: 'rule', probability: null }
  return null
}

/** The verdict when the decision model did not answer. */
export function fallbackVerdict(notification: ExternalNotification): Verdict {
  return { shown: notification.direct, decidedBy: 'fallback', probability: null }
}

/** The verdict from the model's probability that the notification is worth showing. */
export function modelVerdict(probability: number): Verdict {
  return { shown: probability >= SHOW_THRESHOLD, decidedBy: 'model', probability }
}

const QUESTION = 'A notification arrived from one of the person\'s connected apps. Is it worth putting in front of them as something to act on today: a real person asks them for something or waits on their answer, it concerns their own work with a deadline, review or decision, or it is plainly important to them? Newsletters, receipts, marketing, automated alerts, broadcast announcements and social chatter are not.'

/** The question the decision model answers, always named `worthShowing`. */
export function suggestionQuestions(): [DecisionQuestion & { type: 'predicate' }] {
  return [{ type: 'predicate', name: 'worthShowing', instructions: QUESTION }]
}

/** What the decision model reads about a notification. */
export function suggestionState(notification: ExternalNotification): Record<string, string> {
  return {
    app: notification.source,
    from: notification.actor ?? 'unknown',
    addressedToThePerson: notification.direct ? 'yes' : 'not directly',
    title: notification.title,
    content: notification.excerpt || notification.title,
  }
}
