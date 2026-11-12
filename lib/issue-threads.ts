import { readCompactRunFailure, type CompactRunFailure } from './run-failure-view'
import { runIsActive, runSummaryView } from './issue-run-conversation'
import type { RunChain } from './run-chain'
import { BUILTIN_AGENT_PROFILE_ID } from './factory/agent-profile-reference'
import { resolveProfileMark, type ProfileMarkValue } from './factory/agent-profile-mark'

/**
 * A thread is one agent run on an issue, and its content is its owner's alone (R-62):
 * current collaborators see whose thread it is, its status and time, never its prompt,
 * agent, output or messages, and cannot open or join it.
 */
export interface IssueThread {
  failureDetails?: CompactRunFailure | null
  id: string
  status: string
  /** How the run came out once it ended (R-52); null while running or not judged yet. */
  outcome?: string | null
  /** A requested stop is status metadata, including for teammates. */
  stopping: boolean
  /** agent_runs.kind when the read carries it (IssueThreadRow.kind). */
  kind?: string
  createdAt: Date
  finishedAt: Date | null
  ownedByCurrentUser: boolean
  /** Whose thread it is, shown on a teammate's thread instead of its content. */
  ownerName: string | null
  /** `bot`: the dispatching Bot's own bloub look, so every copy of it matches the bot list (R-36); null for the Coordinator's own runs. */
  detail: { name: string; agentName: string; harness: string; summary: string | null; /** Only full owner reads carry the summary's persisted source. */ summarySource?: 'report' | 'error' | null; bot?: { color: string; shape: string } | null; /** A custom Agent Profile that did the run; absent for Default and runs before Profiles. */ profile?: ThreadProfile | null } | null
  /**
   * BE-18 run chain (GitHub Actions run_id + run_attempt): a question continuation is a new
   * run in the same thread. `id` is the root run (attempt 1); stop, status and send act on
   * `latestRunId`. `attempts` is the whole chain in order, root first.
   */
  rootRunId: string
  latestRunId: string
  attempts: IssueThreadAttempt[]
  /**
   * 等你回复 (Figma 382:6469): the owner's chain ended on a Factory question (`waiting`), or
   * its answer is resuming it (`resuming`). Read for the chain's live end (threadQuestionRunId).
   */
  question: ThreadQuestion
  /** Owner-only failure of this queued question child's host wake; its run is unchanged. */
  questionWake?: { generation: string; error: string } | null
  /**
   * The chain's newest attempt when it is not this thread's own run: the run that resumes
   * the thread after its question was answered (lib/factory/questions/store.ts answer →
   * dispatch), or a rerun. It is derived from the run chain, never folded separately, and
   * it is the run `latestRunId` names: what send and stop address.
   */
  continuation: { id: string; status: string; outcome?: string | null; stopping: boolean } | null
}

export interface IssueThreadAttempt {
  failureDetails?: CompactRunFailure | null
  runId: string
  /** 1-based; the root run is attempt 1. */
  attempt: number
  status: string
  outcome?: string | null
  stopping: boolean
  createdAt: Date
  finishedAt: Date | null
}

export type ThreadQuestion = 'waiting' | 'resuming' | null

/** Attach the run's resolved chain; without one the thread is a one-attempt chain. */
export function withRunChain(thread: IssueThread, chain: RunChain | null | undefined): IssueThread {
  if (!chain) return thread
  const attempts = chain.attempts.map(attempt => ({ ...(attempt.failureDetails ? { failureDetails: readCompactRunFailure(attempt.failureDetails) } : {}), runId: attempt.runId, attempt: attempt.attempt, status: attempt.status, outcome: attempt.outcome ?? null,
    stopping: runIsActive(attempt.status) && !!attempt.stopRequestedAt, createdAt: attempt.createdAt, finishedAt: attempt.finishedAt }))
  const latest = attempts.find(attempt => attempt.runId === chain.latestRunId)
  return {
    ...thread, rootRunId: chain.rootRunId, latestRunId: chain.latestRunId, attempts, failureDetails: readCompactRunFailure(latest?.failureDetails),
    continuation: latest && latest.runId !== thread.id ? { id: latest.runId, status: latest.status, outcome: latest.outcome ?? null, stopping: latest.stopping } : null,
  }
}

/**
 * Which run's Factory question this thread shows, if any: the chain's ended live end, or,
 * while an answer's continuation is still queued, the run it resumes (whose question then
 * reads `resuming`). A started live run is already answering: no question.
 */
export function threadQuestionRunId(thread: Pick<IssueThread, 'attempts'>) {
  const tail = thread.attempts.at(-1)
  if (!tail) return null
  if (!runIsActive(tail.status)) return tail.runId
  return tail.status === 'queued' && thread.attempts.length > 1 ? thread.attempts.at(-2)!.runId : null
}

/**
 * The one place the list row, header and composer read a question and the live run from.
 * The live run is the chain's newest attempt (`continuation`, else the thread's own run):
 * status, send and stop follow it. An answered question whose continuation has not started
 * shows as the run it is about to continue: the same running state, nothing new.
 */
export function threadQuestionView(thread: { id: string; status: string; outcome?: string | null; stopping?: boolean; question: ThreadQuestion; questionWake?: IssueThread['questionWake']; continuation?: IssueThread['continuation'] }) {
  const next = thread.continuation ?? null
  // A failed wake offers Retry on this child. The committed answer stays in
  // resuming, so ordinary Send cannot replay it or create another run.
  if (next?.status === 'queued' && thread.question === 'resuming') return { question: 'resuming' as const, waiting: false, status: thread.questionWake ? 'failed' : 'running', outcome: null, runId: next.id, stopping: false }
  const live = next ?? { id: thread.id, status: thread.status, outcome: thread.outcome ?? null, stopping: !!thread.stopping }
  if (live.status === 'queued' && thread.question === 'resuming' && thread.questionWake)
    return { question: 'resuming' as const, waiting: false, status: 'failed', outcome: null, runId: live.id, stopping: false }
  const question = runIsActive(live.status) ? null : thread.question
  return { question, waiting: question === 'waiting', status: question === 'resuming' ? 'running' : live.status, outcome: live.outcome ?? null, runId: live.id, stopping: runIsActive(live.status) && live.stopping }
}

/** Human acceptance resolves only its current candidate's still-waiting producer.
 * This is a display value; run outcomes, historical checks and send authority stay intact. */
export function acceptedProducerOutcome(thread: Pick<IssueThread, 'id' | 'status' | 'outcome' | 'stopping' | 'question' | 'questionWake' | 'continuation' | 'latestRunId'>,
  issueId: string | null, tasks: readonly { issueId: string; stage: string; status: string; candidateId: string | null; candidateRunId: string | null; isSkillCandidate: boolean }[]) {
  const view = threadQuestionView(thread)
  if (!issueId || view.status !== 'succeeded' || view.question || thread.questionWake || thread.stopping || thread.continuation?.stopping ||
    view.runId !== thread.latestRunId || (view.outcome !== null && view.outcome !== 'needs_input')) return view.outcome
  return tasks.some(task => task.issueId === issueId && task.stage === 'approval' && task.status === 'passed' &&
    !task.isSkillCandidate && !!task.candidateId && task.candidateRunId === thread.latestRunId) ? 'done' : view.outcome
}

/** When the row last changed, never after `now`: clock skew with the server must not read as 「1秒钟后」. */
export function threadTime(thread: { createdAt: Date; finishedAt: Date | null }, now: Date) {
  return new Date(Math.min(now.getTime(), new Date(thread.finishedAt ?? thread.createdAt).getTime()))
}

export const ISSUE_THREAD_LIMIT = 20

export interface IssueThreadRow {
  id: string; issueId: string | null; userId: string; status: string; prompt: string
  report: unknown; error: string | null; failureDetails?: unknown; createdAt: Date; finishedAt: Date | null
  agentName: string; harness: string; ownerName?: string | null
  stopRequestedAt?: Date | null
  outcome?: string | null
  /** agent_runs.kind: `implement` and `plan` are the conversation; `acceptance` is a Factory check. */
  kind?: string | null
  botColor?: string | null; botShape?: string | null
  /** The run's frozen Agent Profile summary with its current mark (app/actions/agents.ts); read by threadProfile. */
  profile?: unknown
}

/** The list has already projected the same name and summary in PostgreSQL. */
export type IssueThreadListRow = Omit<IssueThreadRow, 'prompt' | 'report' | 'error'> & {
  name: string
  summary: string | null
}

/** Markdown syntax a prompt may open with ("# Title", "- item", "**bold**"): never part of a name. */
function plainLine(line: string) {
  return line.replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '').replace(/(\*\*|__|`|~~)/g, '').trim()
}

/** The thread's name: the first line of what it was asked to do, as plain text. */
export function threadName(prompt: string, fallback: string) {
  const line = prompt.split('\n').map(part => plainLine(part.trim())).find(Boolean)
  if (!line) return fallback
  return Array.from(line).length > 60 ? `${Array.from(line).slice(0, 59).join('')}…` : line
}

/** Only a thread's owner, while still a collaborator, reads or joins it. */
export function canReadThread(ownerId: string, viewerId: string, memberIds: ReadonlySet<string>) {
  return memberIds.has(viewerId) && ownerId === viewerId
}

/**
 * Who may read a thread that works on no task, for canReadThread: the active
 * members of its bot's workspace, or its owner alone when no bot dispatched it.
 * Null members: the run has a bot whose workspace is gone.
 */
export function taskFreeThreadMembers(ownerId: string, bot: { workspaceMemberIds: readonly string[] | null } | null): ReadonlySet<string> {
  if (!bot) return new Set([ownerId])
  return new Set(bot.workspaceMemberIds ?? [])
}

export function projectIssueThreads(rows: readonly (IssueThreadRow | IssueThreadListRow)[], issueId: string | null, viewerId: string, memberIds: ReadonlySet<string>): IssueThread[] {
  if (!memberIds.has(viewerId)) return []
  // One row per run here; chains are folded once, by root, on the read path (lib/run-chain.ts).
  return rows.filter(row => row.issueId === issueId && memberIds.has(row.userId))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
    .slice(0, ISSUE_THREAD_LIMIT)
    .map(row => ({
      failureDetails: readCompactRunFailure(row.failureDetails),
      id: row.id, status: row.status, outcome: row.outcome ?? null, ...(row.kind ? { kind: row.kind } : {}), createdAt: row.createdAt, finishedAt: row.finishedAt, ownedByCurrentUser: row.userId === viewerId,
      stopping: runIsActive(row.status) && !!row.stopRequestedAt,
      ownerName: row.userId === viewerId ? null : row.ownerName ?? null,
      detail: canReadThread(row.userId, viewerId, memberIds)
        ? { name: 'prompt' in row ? threadName(row.prompt, row.agentName) : row.name, agentName: row.agentName, harness: row.harness, ...('report' in row ? runSummaryView({ report: row.report, error: row.error }) : { summary: row.summary }), bot: row.botColor && row.botShape ? { color: row.botColor, shape: row.botShape } : null, ...(row.profile !== undefined ? { profile: threadProfile(row.profile) } : {}) }
        : null,
      rootRunId: row.id, latestRunId: row.id,
      attempts: [{ runId: row.id, attempt: 1, status: row.status, outcome: row.outcome ?? null, stopping: runIsActive(row.status) && !!row.stopRequestedAt, createdAt: row.createdAt, finishedAt: row.finishedAt }],
      question: null, continuation: null,
    }))
}

export type ThreadProfile = { id: string; name: string } & ProfileMarkValue

/** A custom Profile's name and mark from the read's projection; null for Default, a run without one, or a malformed value. */
export function threadProfile(value: unknown): ThreadProfile | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.profileId !== 'string' || row.profileId === BUILTIN_AGENT_PROFILE_ID || typeof row.name !== 'string') return null
  const roles = Array.isArray(row.roles) ? row.roles.filter((role): role is string => typeof role === 'string') : []
  return { id: row.profileId, name: row.name, ...resolveProfileMark({ name: row.name, roles, description: typeof row.description === 'string' ? row.description : '' }, { icon: row.icon, color: row.color }) }
}

/** A run that is part of the task's conversation: implement or plan. A read without kinds counts every run. */
export const isConversationRun = (thread: { kind?: string }) => !thread.kind || thread.kind === 'implement' || thread.kind === 'plan'

/** Pick from a viewer's authorized conversation heads. The mobile detail and Web root selector
 * use the same ordering, including when an older root received the most recent continuation. */
export function latestConversationRun(runs: readonly { runId: string; kind?: string; createdAt: Date | string }[]): string | null {
  let latest: { runId: string; time: number } | null = null
  for (const run of runs) {
    if (!isConversationRun(run)) continue
    const time = new Date(run.createdAt).getTime()
    if (!latest || time > latest.time || (time === latest.time && run.runId > latest.runId)) latest = { runId: run.runId, time }
  }
  return latest?.runId ?? null
}

/** A teammate's redacted root is activity metadata. A Factory check is readable evidence.
 * Opening either never changes where a reply goes. */
export function taskConversationRoots<T extends Pick<IssueThread, 'id' | 'kind' | 'detail' | 'attempts' | 'latestRunId'> & { createdAt: Date | string }>(threads: readonly T[]) {
  const readable = threads.filter(thread => thread.detail !== null).sort((a, b) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id))
  const latestId = latestConversationRun(readable.map(thread => ({
    runId: thread.latestRunId, kind: thread.kind,
    createdAt: thread.attempts.find(attempt => attempt.runId === thread.latestRunId)?.createdAt ?? thread.createdAt,
  })))
  return { readable, reply: readable.find(thread => thread.latestRunId === latestId) ?? null }
}

/**
 * One conversation per task (decision 2026-11-09-0045): consecutive threads by the same Agent and the
 * same custom Agent 配置 are one stretch (Alex, 2026-11-10: the Profile is who does the work).
 * `profile` is the custom Profile's id, null for Default and runs before Profiles. Oldest first; a stretch opens at its first thread and reads as its last. A thread whose
 * detail the reader cannot see has no Agent and stands alone unless the one before is hidden too.
 */
export function agentStretches<T extends { id: string; kind?: string; createdAt: Date | string; detail: { harness: string; profile?: { id: string } | null } | null }>(threads: readonly T[]): { agent: string | null; profile: string | null; first: T; last: T; ids: string[] }[] {
  const out: { agent: string | null; profile: string | null; first: T; last: T; ids: string[] }[] = []
  // Only the conversation's own runs make stretches; a Factory check (review, verify) is its result card on the
  // task page (2026-11-04-2200), never a 「换 Codex」 row.
  for (const thread of [...threads].filter(isConversationRun).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())) {
    const agent = thread.detail?.harness ?? null, profile = thread.detail?.profile?.id ?? null
    const previous = out.at(-1)
    if (previous && previous.agent === agent && previous.profile === profile) { previous.last = thread; previous.ids.push(thread.id) }
    else out.push({ agent, profile, first: thread, last: thread, ids: [thread.id] })
  }
  return out
}
