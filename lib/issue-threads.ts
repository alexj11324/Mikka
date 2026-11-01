import { runIsActive, runSummaryText } from './issue-run-conversation'
import type { RunChain } from './run-chain'

/**
 * A thread is one agent run on an issue, and its content is its owner's alone (R-62):
 * current collaborators see whose thread it is, its status and time, never its prompt,
 * agent, output or messages, and cannot open or join it.
 */
export interface IssueThread {
  id: string
  status: string
  /** How the run came out once it ended (R-52); null while running or not judged yet. */
  outcome?: string | null
  /** A requested stop is status metadata, including for teammates. */
  stopping: boolean
  createdAt: Date
  finishedAt: Date | null
  ownedByCurrentUser: boolean
  /** Whose thread it is, shown on a teammate's thread instead of its content. */
  ownerName: string | null
  /** `bot`: the dispatching Bot's own bloub look, so every copy of it matches the bot list (R-36); null for the Coordinator's own runs. */
  detail: { name: string; agentName: string; harness: string; summary: string | null; bot?: { color: string; shape: string } | null } | null
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
  /**
   * The chain's newest attempt when it is not this thread's own run: the run that resumes
   * the thread after its question was answered (lib/factory/questions/store.ts answer →
   * dispatch), or a rerun. It is derived from the run chain, never folded separately, and
   * it is the run `latestRunId` names: what send and stop address.
   */
  continuation: { id: string; status: string; outcome?: string | null; stopping: boolean } | null
}

export interface IssueThreadAttempt {
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
  const attempts = chain.attempts.map(attempt => ({ runId: attempt.runId, attempt: attempt.attempt, status: attempt.status, outcome: attempt.outcome ?? null,
    stopping: runIsActive(attempt.status) && !!attempt.stopRequestedAt, createdAt: attempt.createdAt, finishedAt: attempt.finishedAt }))
  const latest = attempts.find(attempt => attempt.runId === chain.latestRunId)
  return {
    ...thread, rootRunId: chain.rootRunId, latestRunId: chain.latestRunId, attempts,
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
export function threadQuestionView(thread: { id: string; status: string; outcome?: string | null; stopping?: boolean; question: ThreadQuestion; continuation?: IssueThread['continuation'] }) {
  const next = thread.continuation ?? null
  // Answered, continuation not started yet: still running, nothing to send or stop.
  if (next?.status === 'queued' && thread.question === 'resuming') return { question: 'resuming' as const, waiting: false, status: 'running', outcome: null, runId: next.id, stopping: false }
  const live = next ?? { id: thread.id, status: thread.status, outcome: thread.outcome ?? null, stopping: !!thread.stopping }
  const question = runIsActive(live.status) ? null : thread.question
  return { question, waiting: question === 'waiting', status: question === 'resuming' ? 'running' : live.status, outcome: live.outcome ?? null, runId: live.id, stopping: runIsActive(live.status) && live.stopping }
}

/** When the row last changed, never after `now`: clock skew with the server must not read as 「1秒钟后」. */
export function threadTime(thread: { createdAt: Date; finishedAt: Date | null }, now: Date) {
  return new Date(Math.min(now.getTime(), new Date(thread.finishedAt ?? thread.createdAt).getTime()))
}

export const ISSUE_THREAD_LIMIT = 20

export interface IssueThreadRow {
  id: string; issueId: string | null; userId: string; status: string; prompt: string
  report: unknown; error: string | null; createdAt: Date; finishedAt: Date | null
  agentName: string; harness: string; ownerName?: string | null
  stopRequestedAt?: Date | null
  outcome?: string | null
  botColor?: string | null; botShape?: string | null
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

export function projectIssueThreads(rows: readonly IssueThreadRow[], issueId: string, viewerId: string, memberIds: ReadonlySet<string>): IssueThread[] {
  if (!memberIds.has(viewerId)) return []
  // One row per run here; chains are folded once, by root, on the read path (lib/run-chain.ts).
  return rows.filter(row => row.issueId === issueId && memberIds.has(row.userId))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
    .slice(0, ISSUE_THREAD_LIMIT)
    .map(row => ({
      id: row.id, status: row.status, outcome: row.outcome ?? null, createdAt: row.createdAt, finishedAt: row.finishedAt, ownedByCurrentUser: row.userId === viewerId,
      stopping: runIsActive(row.status) && !!row.stopRequestedAt,
      ownerName: row.userId === viewerId ? null : row.ownerName ?? null,
      detail: canReadThread(row.userId, viewerId, memberIds)
        ? { name: threadName(row.prompt, row.agentName), agentName: row.agentName, harness: row.harness, summary: runSummaryText({ report: row.report, error: row.error }), bot: row.botColor && row.botShape ? { color: row.botColor, shape: row.botShape } : null }
        : null,
      rootRunId: row.id, latestRunId: row.id,
      attempts: [{ runId: row.id, attempt: 1, status: row.status, outcome: row.outcome ?? null, stopping: runIsActive(row.status) && !!row.stopRequestedAt, createdAt: row.createdAt, finishedAt: row.finishedAt }],
      question: null, continuation: null,
    }))
}
