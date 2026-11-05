// What the 验收 tab (Figma 357:4750, frame 06) shows, built from the task
// detail (checks and delivery header) and the evidence manifest. Pure, so the
// grouping is testable without a server.

import type { EvidenceEntry } from './evidence-view'
import type { QuestionCommandOrigin } from './question-command-sources'

export type CheckStatus = 'pending' | 'running' | 'waiting' | 'passed' | 'failed' | 'blocked' | 'cancelled' | 'revoked'
export interface AcceptanceCheck {
  attemptId: string
  stage: 'review' | 'verify' | 'monitor'
  status: CheckStatus
  candidateId: string | null
  candidateSha: string | null
  runId: string | null
  /** `command` and `exitCode` (#541): what checked this criterion, when the verify agent reported it. */
  criteria: { criterionId: string | null; text: string | null; passed: boolean; evidence: string | null; command?: string | null; exitCode?: number | null }[]
  verify: { status: string; command: string | null; exitCode: number | null } | null
  /** Host-validated sources actually cited by this check on the current candidate. */
  commandSources?: QuestionCommandOrigin[]
}
/**
 * The task detail's delivery header. `pullRequest.title`, `previewDatabaseBranch`
 * and `machine` come with #541 and stay optional, so the card works before and
 * after the backend sends them.
 */
export interface AcceptanceDelivery {
  candidateSha: string | null
  pullRequest: { url: string; state: 'open' | 'draft' | 'merged' | 'closed'; title?: string | null } | null
  repository: string | null
  previewUrl: string | null
  /** The Neon preview branch the run used, such as `preview/mik-48`. */
  previewDatabaseBranch?: string | null
  /** The device or cloud machine that produced the candidate. */
  machine?: CandidateMachine | null
  machineName?: string | null
  environment?: string | null
}
export interface CandidateMachine { name: string; kind: 'device' | 'cloud' }
export interface AcceptanceTaskView {
  id?: string
  issueId?: string
  attemptId?: string
  stage: string
  status: string
  reason?: string
  route?: { flowVersion?: number }
  candidateId: string | null
  revision?: number
  completionRecovery?: { binding: { taskId: string; revision: number } }
}
export interface AcceptanceDetail { task?: AcceptanceTaskView; checks?: AcceptanceCheck[]; delivery?: AcceptanceDelivery; completionRecovery?: AcceptanceTaskView['completionRecovery']; checkStartRecovery?: { binding: { taskId: string; revision: number } }; checkDispatchRecovery?: { binding: { taskId: string; revision: number } }; liveWorkspaceId?: string | null }
export interface AcceptanceBinding { taskId: string; issueId: string; attemptId: string; revision: number; candidateId: string | null }
export type CandidateCheckState = { stage: 'review' | 'verify'; status: 'failed' | 'pending' | 'running' | 'blocked' }

/** A fixed candidate remains reachable while its independent checks need attention. */
export function candidateCheckState(task: AcceptanceTaskView): CandidateCheckState | null {
  if (task.completionRecovery || !task.candidateId || (task.stage !== 'review' && task.stage !== 'verify')) return null
  if (task.status !== 'failed' && task.status !== 'pending' && task.status !== 'running' && task.status !== 'blocked') return null
  return { stage: task.stage, status: task.status }
}

export function visibleAcceptance(task: AcceptanceTaskView): boolean {
  return Boolean(task.completionRecovery) || (task.stage === 'approval' && ['pending', 'waiting', 'passed'].includes(task.status)) ||
    task.stage === 'publish' || candidateCheckState(task) !== null
}

const checkRecoveryMatches = (task: AcceptanceTaskView, recovery: AcceptanceDetail['checkStartRecovery']) =>
  task.status === 'blocked' && recovery?.binding?.taskId === task.id && recovery?.binding?.revision === task.revision

/** A blocked check also needs the host's recovery capability; all reads must name one exact attempt. */
export function candidateCheckRetry(task: AcceptanceTaskView, detail: AcceptanceDetail | undefined, ledger: AcceptanceBinding | undefined) {
  const state = candidateCheckState(task)
  const current = detail?.task
  const recoveringStart = checkRecoveryMatches(task, detail?.checkStartRecovery)
  const recoveringDispatch = checkRecoveryMatches(task, detail?.checkDispatchRecovery)
  if (!state || (state.status !== 'failed' && !recoveringStart && !recoveringDispatch) || !detail || detail.completionRecovery || !current || !ledger ||
    !task.id || !task.issueId || !task.attemptId || typeof task.revision !== 'number' ||
    !Number.isSafeInteger(task.revision) || task.revision < 0) return null
  if (current.id !== task.id || current.issueId !== task.issueId || current.attemptId !== task.attemptId ||
    current.candidateId !== task.candidateId || current.revision !== task.revision ||
    current.stage !== task.stage || current.status !== task.status) return null
  if (ledger.taskId !== task.id || ledger.issueId !== task.issueId || ledger.attemptId !== task.attemptId ||
    ledger.candidateId !== task.candidateId || ledger.revision !== task.revision) return null
  const latest = latestCheck(Array.isArray(detail.checks) ? detail.checks : [], state.stage, task.candidateId)
  if (!latest || latest.attemptId !== task.attemptId || latest.status !== state.status) return null
  if (recoveringDispatch && (recoveringStart || latest.runId !== null)) return null
  if (current.route?.flowVersion === 2 && state.stage === 'review' && state.status === 'failed') return null
  return {
    stage: state.stage,
    key: JSON.stringify([task.id, task.issueId, task.attemptId, task.candidateId, task.revision]),
    binding: { taskId: task.id, revision: task.revision },
  }
}

/** Ordinary retries queue one check; host-qualified start recovery also binds its new run atomically. */
export function candidateCheckRetryConfirmed(task: AcceptanceTaskView, value: unknown, recovery?: AcceptanceDetail['checkStartRecovery'], dispatchRecovery?: AcceptanceDetail['checkDispatchRecovery']): boolean {
  const state = candidateCheckState(task)
  const recoveringStart = state?.status === 'blocked' && checkRecoveryMatches(task, recovery)
  const recoveringDispatch = state?.status === 'blocked' && checkRecoveryMatches(task, dispatchRecovery)
  if (!state || (state.status !== 'failed' && !recoveringStart && !recoveringDispatch) || (recoveringStart && recoveringDispatch) || !task.id || !task.issueId || !task.attemptId ||
    typeof task.revision !== 'number' || !Number.isSafeInteger(task.revision)) return false
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const receipt = value as Record<string, unknown>
  if (receipt.contractVersion !== 1 || !Array.isArray(receipt.attempts) || !Array.isArray(receipt.candidates) ||
    !receipt.task || typeof receipt.task !== 'object' || Array.isArray(receipt.task)) return false
  const next = receipt.task as Record<string, unknown>
  const nextStatus = recoveringStart ? 'running' : 'pending'
  return next.id === task.id && next.issueId === task.issueId && next.candidateId === task.candidateId &&
    next.stage === task.stage && next.status === nextStatus && typeof next.revision === 'number' && Number.isSafeInteger(next.revision) &&
    next.revision === task.revision + (recoveringStart ? 2 : 1) && typeof next.attemptId === 'string' && next.attemptId.length > 0 &&
    next.attemptId !== task.attemptId && receipt.attempts.some(attempt => attempt && typeof attempt === 'object' &&
      attempt.id === next.attemptId && attempt.taskId === task.id && attempt.candidateId === task.candidateId &&
      attempt.stage === task.stage && attempt.status === nextStatus &&
      (!recoveringStart || (typeof attempt.runId === 'string' && attempt.runId.length > 0)) &&
      (!recoveringDispatch || attempt.runId === null))
}

/** One piece of evidence plus, for text from a verify run, the command it ran. */
export interface AcceptanceItem { entry: EvidenceEntry; command: { text: string; exitCode: number | null } | null }
export interface CriterionGroup { key: string; title: string | null; passed: boolean | null; items: AcceptanceItem[] }
export interface ResultRow { stage: 'review' | 'verify'; status: CheckStatus; runId: string | null; sha: string | null; passed: number; total: number; commandSources?: QuestionCommandOrigin[] }

const isMedia = (entry: EvidenceEntry) => Boolean(entry.captureId) && (entry.kind === 'screenshot' || entry.kind === 'video')

/** The latest check of a stage on the current candidate (checks come in attempt order). */
export function latestCheck(checks: readonly AcceptanceCheck[], stage: 'review' | 'verify', candidateId: string | null) {
  return checks.filter(check => check.stage === stage && (candidateId === null || check.candidateId === candidateId)).at(-1)
}

/** Does a criterion's evidence text name this entry (its artifact, capture id or title)? */
function names(criterion: AcceptanceCheck['criteria'][number], entry: EvidenceEntry) {
  const text = criterion.evidence
  if (!text) return false
  return text.includes(entry.artifact) || Boolean(entry.captureId && text.includes(entry.captureId)) || Boolean(entry.title && text.includes(entry.title))
}

/**
 * 验收标准: one group per criterion of the latest verify check, each with the
 * evidence its report names. Evidence no criterion names stays in a last group
 * without a title, so nothing the reviewer was given disappears. Text from the
 * verify run carries its command and exit code (`pnpm e2e · exit 0`): the one
 * that checked its criterion when the report names it, else the run's.
 */
export function criterionGroups(entries: readonly EvidenceEntry[], checks: readonly AcceptanceCheck[], candidateId: string | null): CriterionGroup[] {
  const verify = latestCheck(checks, 'verify', candidateId)
  const runCommand = verify?.verify?.command ? { text: verify.verify.command, exitCode: verify.verify.exitCode } : null
  const item = (entry: EvidenceEntry, command = runCommand): AcceptanceItem => ({ entry, command: !isMedia(entry) && command && entry.runId === verify?.runId ? command : null })
  const used = new Set<number>()
  const groups: CriterionGroup[] = (verify?.criteria ?? []).map((criterion, position) => {
    const own = criterion.command ? { text: criterion.command, exitCode: criterion.exitCode ?? null } : runCommand
    const items: AcceptanceItem[] = []
    entries.forEach((entry, index) => { if (names(criterion, entry)) { used.add(index); items.push(item(entry, own)) } })
    return { key: criterion.criterionId ?? `criterion-${position}`, title: criterion.text, passed: criterion.passed, items }
  })
  const rest = entries.filter((_, index) => !used.has(index)).map(entry => item(entry))
  if (rest.length) groups.push({ key: 'other', title: null, passed: null, items: rest })
  return groups
}

/** 独立结果: the latest review and verify on the current candidate. */
export function resultRows(checks: readonly AcceptanceCheck[], candidateId: string | null): ResultRow[] {
  return (['review', 'verify'] as const).flatMap(stage => {
    const check = latestCheck(checks, stage, candidateId)
    if (!check) return []
    return [{ stage, status: check.status, runId: check.runId, sha: check.candidateSha, passed: check.criteria.filter(c => c.passed).length, total: check.criteria.length, commandSources: check.commandSources }]
  })
}

/** #418 from a GitHub pull request URL. */
export const pullNumber = (url: string) => /\/pull\/(\d+)(?:[/?#]|$)/.exec(url)?.[1] ?? null

/** The host and path of a preview URL, as Figma prints it (no scheme). */
export const bareUrl = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '')
