// What the 验收 tab (Figma 357:4750, frame 06) shows, built from the task
// detail (checks and delivery header) and the evidence manifest. Pure, so the
// grouping is testable without a server.

import type { EvidenceEntry } from './evidence-view'

export type CheckStatus = 'pending' | 'running' | 'waiting' | 'passed' | 'failed' | 'blocked' | 'cancelled' | 'revoked'
export interface AcceptanceCheck {
  attemptId: string
  stage: 'review' | 'verify' | 'monitor'
  status: CheckStatus
  candidateId: string | null
  candidateSha: string | null
  runId: string | null
  criteria: { criterionId: string | null; text: string | null; passed: boolean; evidence: string | null }[]
  verify: { status: string; command: string | null; exitCode: number | null } | null
}
export interface AcceptanceDelivery {
  candidateSha: string | null
  pullRequest: { url: string; state: 'open' | 'draft' | 'merged' | 'closed' } | null
  repository: string | null
  previewUrl: string | null
}
export interface AcceptanceDetail { checks?: AcceptanceCheck[]; delivery?: AcceptanceDelivery }

/** One piece of evidence plus, for text from a verify run, the command it ran. */
export interface AcceptanceItem { entry: EvidenceEntry; command: { text: string; exitCode: number | null } | null }
export interface CriterionGroup { key: string; title: string | null; passed: boolean | null; items: AcceptanceItem[] }
export interface ResultRow { stage: 'review' | 'verify'; status: CheckStatus; runId: string | null; sha: string | null; passed: number; total: number }

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
 * verify run carries its command and exit code (`pnpm e2e · exit 0`).
 */
export function criterionGroups(entries: readonly EvidenceEntry[], checks: readonly AcceptanceCheck[], candidateId: string | null): CriterionGroup[] {
  const verify = latestCheck(checks, 'verify', candidateId)
  const command = verify?.verify?.command ? { text: verify.verify.command, exitCode: verify.verify.exitCode } : null
  const item = (entry: EvidenceEntry): AcceptanceItem => ({ entry, command: !isMedia(entry) && command && entry.runId === verify?.runId ? command : null })
  const used = new Set<number>()
  const groups: CriterionGroup[] = (verify?.criteria ?? []).map((criterion, position) => {
    const items: AcceptanceItem[] = []
    entries.forEach((entry, index) => { if (names(criterion, entry)) { used.add(index); items.push(item(entry)) } })
    return { key: criterion.criterionId ?? `criterion-${position}`, title: criterion.text, passed: criterion.passed, items }
  })
  const rest = entries.filter((_, index) => !used.has(index)).map(item)
  if (rest.length) groups.push({ key: 'other', title: null, passed: null, items: rest })
  return groups
}

/** 独立结果: the latest review and verify on the current candidate. */
export function resultRows(checks: readonly AcceptanceCheck[], candidateId: string | null): ResultRow[] {
  return (['review', 'verify'] as const).flatMap(stage => {
    const check = latestCheck(checks, stage, candidateId)
    if (!check) return []
    return [{ stage, status: check.status, runId: check.runId, sha: check.candidateSha, passed: check.criteria.filter(c => c.passed).length, total: check.criteria.length }]
  })
}

/** #418 from a GitHub pull request URL. */
export const pullNumber = (url: string) => /\/pull\/(\d+)(?:[/?#]|$)/.exec(url)?.[1] ?? null

/** The host and path of a preview URL, as Figma prints it (no scheme). */
export const bareUrl = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '')
