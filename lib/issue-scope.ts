import type { DecisionQuestion } from '@/lib/coordinator/decision'
import type { TaskScope } from '@/lib/task-identifier'

// Whether a new task belongs to the workspace (and so goes to Linear) or to
// the person (MIK-47). The decision model judges it; only a confident
// "workspace" moves it, because a personal task can still be moved to Linear
// later and a task written into the company's Linear cannot be taken back.

/** At or above this probability a task is a workspace task. */
export const WORKSPACE_THRESHOLD = 0.8
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

const QUESTION = 'Someone created this task in their own task list. Is it work for their team in the connected Linear team (a bug, feature, review, release, customer or company work that teammates should see), rather than a personal task (errands, appointments, private reminders, personal learning or anything about their own life)? Follow the examples from their own earlier corrections when they are similar.'

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

export function scopeFromProbability(probability: number): TaskScope {
  return probability >= WORKSPACE_THRESHOLD ? 'workspace' : 'personal'
}
