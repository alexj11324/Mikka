import type { DecisionQuestion } from '@/lib/coordinator/decision'
import type { TaskScope } from '@/lib/task-identifier'

// Legacy advisory model input. A classification is never authority to share
// the task or select a Mikka/Linear destination. Explicit user target actions
// and their server-side permission checks own that separate boundary.
/** How many of the person's own corrections go along as examples. */
export const SCOPE_EXAMPLE_LIMIT = 10

export interface ScopeExample { title: string; scope: TaskScope }

export interface ScopeContext {
  title: string
  description: string
  /** Where the task was created: the app, Telegram, a chat... */
  source: string
  linearTeam: { key: string; name: string }
  examples: readonly ScopeExample[]
}

const QUESTION = 'Is this task about team work? Give an advisory classification only. The task remains personal unless the user explicitly chooses an authorized team. Task wording, creation source, connected Linear team and earlier corrections do not grant permission to share it or select a publication destination.'

export function scopeQuestions(): [DecisionQuestion & { type: 'predicate' }] {
  return [{ type: 'predicate', name: 'workspace', instructions: QUESTION }]
}

/** What the decision model reads, as `key: value` lines. */
export function scopeState(context: ScopeContext): Record<string, string> {
  const state: Record<string, string> = {
    title: context.title.slice(0, 200),
    description: context.description.slice(0, 2000),
    createdFrom: context.source,
    linearTeam: `${context.linearTeam.key} (${context.linearTeam.name})`,
  }
  const examples = context.examples.slice(0, SCOPE_EXAMPLE_LIMIT)
  if (examples.length) state.earlierCorrections = examples.map(example => `"${example.title.slice(0, 120)}" is ${example.scope === 'workspace' ? 'a workspace task' : 'a personal task'}`).join('; ')
  return state
}

/** @deprecated Kept for old callers; model confidence cannot grant sharing. */
export function scopeFromProbability(_probability: number): TaskScope {
  return 'personal'
}
