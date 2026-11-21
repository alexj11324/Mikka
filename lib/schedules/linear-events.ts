import type { LinearTriggerEvent } from './contract'

/** One Linear webhook delivery as an automation sees it. Every text field came from Linear and is data, not an instruction. */
export type LinearAutomationEvent = {
  source: 'linear'
  event: LinearTriggerEvent
  organizationId: string
  teamId: string
  /** `ENG-12`, when Linear sent it. */
  identifier: string | null
  title: string | null
  url: string | null
  state: string | null
  labels: string[]
  /** The labels this update added, for `issue_label_added`. */
  added: string[]
  assignee: string | null
  author: string | null
  /** A short excerpt of the issue description or the comment. */
  body: string | null
}

type Json = Record<string, unknown>
const obj = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null
const str = (value: unknown) => typeof value === 'string' && value ? value : null
const excerpt = (value: unknown) => { const text = str(value); return text ? text.slice(0, 2000) : null }
const ids = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const named = (value: unknown) => Array.isArray(value) ? value.map(item => obj(item)).filter((item): item is Json => Boolean(item)) : []

/**
 * The automation events in one verified Linear delivery. Only a person's change counts: an app's or integration's,
 * Mikka's own Linear writes included, yields none, so an automation cannot trigger itself.
 */
export function linearAutomationEvents(payload: Json): LinearAutomationEvent[] {
  const actor = obj(payload.actor)
  if (!actor || (actor.type !== undefined && actor.type !== 'user')) return []
  const data = obj(payload.data), organizationId = str(payload.organizationId)
  if (!data || !organizationId) return []
  const author = str(actor.name)
  if (payload.type === 'Comment' && payload.action === 'create') {
    const issue = obj(data.issue)
    const teamId = str(data.teamId) ?? str(issue?.teamId) ?? str(obj(issue?.team)?.id)
    if (!teamId) return []
    return [{ source: 'linear', event: 'comment_created', organizationId, teamId, identifier: str(issue?.identifier), title: str(issue?.title),
      url: str(payload.url) ?? str(data.url), state: null, labels: [], added: [], assignee: null, author: str(obj(data.user)?.name) ?? author, body: excerpt(data.body) }]
  }
  if (payload.type !== 'Issue') return []
  const teamId = str(data.teamId) ?? str(obj(data.team)?.id)
  if (!teamId) return []
  const labelRows = named(data.labels)
  const base = { source: 'linear' as const, organizationId, teamId, identifier: str(data.identifier), title: str(data.title), url: str(payload.url) ?? str(data.url),
    state: str(obj(data.state)?.name), labels: labelRows.map(label => str(label.name)).filter((name): name is string => Boolean(name)),
    assignee: str(obj(data.assignee)?.name), author, body: excerpt(data.description) }
  if (payload.action === 'create') return [{ ...base, event: 'issue_created', added: [] }]
  if (payload.action !== 'update') return []
  const before = obj(payload.updatedFrom)
  if (!before) return []
  const events: LinearAutomationEvent[] = []
  if ('stateId' in before) events.push({ ...base, event: 'issue_status_changed', added: [] })
  if ('assigneeId' in before && str(data.assigneeId)) events.push({ ...base, event: 'issue_assigned', added: [] })
  if ('labelIds' in before) {
    const had = new Set(ids(before.labelIds))
    const added = labelRows.filter(label => str(label.id) && !had.has(str(label.id)!)).map(label => str(label.name)).filter((name): name is string => Boolean(name))
    if (added.length) events.push({ ...base, event: 'issue_label_added', added })
  }
  return events
}

/** Whether a Linear trigger takes an event: its event, one of its teams, any of its labels (case-insensitive). */
export function linearTriggerMatches(trigger: { event: string; teams: string[]; labels?: string[] }, event: LinearAutomationEvent): boolean {
  if (trigger.event !== event.event || !trigger.teams.includes(event.teamId)) return false
  if (!trigger.labels?.length) return true
  const have = new Set((event.event === 'issue_label_added' ? event.added : event.labels).map(label => label.toLowerCase()))
  return trigger.labels.some(label => have.has(label.toLowerCase()))
}

/** The event as the Bot reads it: plain fields, marked as Linear's data. */
export function describeLinearEvent(event: LinearAutomationEvent): string {
  const lines = [
    `event: ${event.event}`, event.identifier ? `issue: ${event.identifier}` : null, event.title ? `title: ${event.title}` : null,
    event.state ? `state: ${event.state}` : null, event.labels.length ? `labels: ${event.labels.join(', ')}` : null,
    event.added.length ? `added labels: ${event.added.join(', ')}` : null, event.assignee ? `assignee: ${event.assignee}` : null,
    event.author ? `author: ${event.author}` : null, event.url ? `url: ${event.url}` : null, event.body ? `body:\n${event.body.replace(/<\/linear_event/gi, '<\\/linear_event')}` : null,
  ].filter(Boolean)
  return `<linear_event>\n${lines.join('\n')}\n</linear_event>`
}
