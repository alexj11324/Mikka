import type { EventTrigger, GitHubTriggerEvent } from './contract'

/** One GitHub delivery as an automation sees it. Every text field came from GitHub and is data, not an instruction. */
export type GitHubAutomationEvent = {
  source: 'github'
  event: GitHubTriggerEvent
  /** `v2/github.com/<owner>/<name>`, lower case. */
  repository: string
  /** The branch the change targets: a PR's base, a check suite's head branch. */
  branch: string | null
  labels: string[]
  /** The label added or removed, for `label_change`. */
  label: string | null
  number: number | null
  title: string | null
  url: string | null
  pullAuthor?: string | null
  author: string | null
  /** A short excerpt of a comment or review body. */
  body: string | null
}

type Json = Record<string, unknown>
const obj = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null
const str = (value: unknown) => typeof value === 'string' ? value : null
const excerpt = (value: unknown) => { const text = str(value); return text ? text.slice(0, 2000) : null }
const labelNames = (value: unknown) => Array.isArray(value) ? value.map(item => str(obj(item)?.name)).filter((name): name is string => Boolean(name)) : []
const FAILED_CHECKS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure'])

/**
 * The automation events in one verified GitHub delivery. A bot's own activity yields none, so an automation that
 * pushes to a pull request is not woken by its own push.
 */
export function githubAutomationEvents(name: string, payload: Json): GitHubAutomationEvent[] {
  const repository = str(obj(payload.repository)?.full_name)
  if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) return []
  if (str(obj(payload.sender)?.type) === 'Bot') return []
  const action = str(payload.action)
  const pr = obj(payload.pull_request)
  const issue = obj(payload.issue)
  const base = (event: GitHubTriggerEvent, item: Json | null, extra: Partial<GitHubAutomationEvent> = {}): GitHubAutomationEvent => ({
    source: 'github', event, repository: `v2/github.com/${repository.toLowerCase()}`,
    branch: str(obj(item?.base)?.ref), labels: labelNames(item?.labels), label: null,
    number: typeof item?.number === 'number' ? item.number : null, title: str(item?.title), url: str(item?.html_url),
    ...(pr ? { pullAuthor: str(obj(pr.user)?.login) } : {}),
    author: str(obj(item?.user)?.login), body: null, ...extra,
  })
  if (name === 'pull_request' && pr) {
    if (action === 'opened' || action === 'reopened') return [base(pr.draft === true ? 'draft_opened' : 'pull_request_opened', pr)]
    if (action === 'ready_for_review') return [base('pull_request_opened', pr)]
    if (action === 'synchronize') return [base('pull_request_pushed', pr)]
    if (action === 'closed') return [base(pr.merged === true ? 'pull_request_merged' : 'pull_request_closed', pr)]
    if (action === 'labeled' || action === 'unlabeled') return [base('label_change', pr, { label: str(obj(payload.label)?.name) })]
    return []
  }
  if (name === 'issues' && issue) {
    if (action === 'opened') return [base('issue_opened', issue)]
    if (action === 'labeled' || action === 'unlabeled') return [base('label_change', issue, { label: str(obj(payload.label)?.name) })]
    return []
  }
  if (name === 'issue_comment' && issue && action === 'created') {
    const comment = obj(payload.comment)
    return [base('comment', issue, { author: str(obj(comment?.user)?.login), body: excerpt(comment?.body), url: str(comment?.html_url) ?? str(issue.html_url) })]
  }
  if (name === 'pull_request_review' && pr && action === 'submitted') {
    const review = obj(payload.review)
    return [base('review_submitted', pr, { author: str(obj(review?.user)?.login), body: excerpt(review?.body), url: str(review?.html_url) ?? str(pr.html_url) })]
  }
  if (name === 'pull_request_review_comment' && pr && action === 'created') {
    const comment = obj(payload.comment)
    return [base('review_comment', pr, { author: str(obj(comment?.user)?.login), body: excerpt(comment?.body), url: str(comment?.html_url) ?? str(pr.html_url) })]
  }
  if (name === 'check_suite' && action === 'completed') {
    const suite = obj(payload.check_suite)
    const linked = Array.isArray(suite?.pull_requests) ? obj(suite.pull_requests[0]) : null
    const event = base('checks_completed', null, {
      branch: str(suite?.head_branch), number: typeof linked?.number === 'number' ? linked.number : null,
      title: str(suite?.conclusion), url: str(obj(payload.repository)?.html_url), author: str(obj(suite?.app)?.slug),
    })
    return FAILED_CHECKS.has(str(suite?.conclusion) ?? '') ? [event, { ...event, event: 'checks_failed' }] : [event]
  }
  return []
}

const lower = (values: readonly string[] | undefined) => values?.map(value => value.toLowerCase())

/** Whether this trigger's structured filters (event, repository, branch, labels) take the event. `runWhen` is judged later. */
export function triggerMatches(trigger: EventTrigger, event: GitHubAutomationEvent): boolean {
  if (trigger.source !== 'github' || trigger.event !== event.event) return false
  if (!trigger.repositories.includes(event.repository)) return false
  if (trigger.branches?.length && !(event.branch && trigger.branches.includes(event.branch))) return false
  if (trigger.pullAuthors?.length && !trigger.pullAuthors.some(name => name.toLowerCase() === event.pullAuthor?.toLowerCase())) return false
  const wanted = lower(trigger.labels)
  if (wanted?.length) {
    const have = new Set([...event.labels, ...(event.label ? [event.label] : [])].map(label => label.toLowerCase()))
    if (!wanted.some(label => have.has(label))) return false
  }
  return true
}

/** The event as the Bot reads it: plain fields, marked as GitHub's data. */
export function describeGitHubEvent(event: GitHubAutomationEvent): string {
  const lines = [
    `event: ${event.event}`, `repository: ${event.repository.replace(/^v2\/github\.com\//, '')}`,
    event.number !== null ? `number: #${event.number}` : null, event.title ? `title: ${event.title}` : null,
    event.branch ? `branch: ${event.branch}` : null, event.label ? `label: ${event.label}` : null,
    event.labels.length ? `labels: ${event.labels.join(', ')}` : null, event.author ? `author: ${event.author}` : null,
    event.url ? `url: ${event.url}` : null, event.body ? `body:\n${event.body}` : null,
  ].filter(Boolean)
  return `<github_event>\n${lines.join('\n')}\n</github_event>`
}
