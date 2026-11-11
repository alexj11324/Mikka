import 'server-only'
import { z } from 'zod'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { WorkspaceReviewError } from '@mikka/protocol/coding-workspace-review'
import type { Masker } from '../../secrets/mask'
import type { GitHubPullGrant } from '../diff/github'
import { diffDigest } from '../diff/patch'

const id = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String), z.string().regex(/^[1-9]\d{0,39}$/)])
const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
const count = z.number().int().nonnegative().max(100_000)
const text = z.string().max(256 * 1024)
const checkRun = z.object({ id, head_sha: sha, name: text.min(1), status: z.enum(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']),
  conclusion: z.enum(['action_required', 'cancelled', 'failure', 'neutral', 'success', 'skipped', 'stale', 'timed_out']).nullable(),
  completed_at: z.string().nullable(), html_url: z.string().nullable().optional(), details_url: z.string().nullable().optional(),
  output: z.object({ title: text.nullable(), summary: text.nullable(), text: text.nullable() }).nullable() })
const commitStatus = z.object({ id, state: z.enum(['error', 'failure', 'pending', 'success']), context: text.min(1),
  description: text.nullable(), updated_at: z.string() })
export const observedReviewCheck = z.strictObject({ nativeId: id, kind: z.enum(['check_run', 'commit_status']), name: z.string().min(1).max(200),
  nameTruncated: z.boolean(), status: z.enum(['failed', 'passed', 'pending', 'neutral']), conclusion: z.string().nullable(),
  logExcerpt: z.string().max(2000), logTruncated: z.boolean(), logUrl: z.string().url().max(4096).optional(), detailDigest: z.string().regex(/^[a-f0-9]{64}$/) })
export const observedReviewChecks = z.strictObject({ repositoryId: id, headSha: sha, fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: z.iso.datetime(), checks: z.array(observedReviewCheck).max(500), counts: z.strictObject({ total: count, failed: count, passed: count, pending: count, neutral: count }) })
export type ObservedReviewChecks = z.infer<typeof observedReviewChecks>
const unavailable = () => new WorkspaceReviewError('workspace_review_github_unavailable')
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw unavailable()
  return result.data
}

/** Browser destinations only: never fetch logs or infer a URL from output.
 * The row itself came from this repository's exact immutable head query. */
function nativeCheckUrl(value: string | null | undefined, fullName: string, nativeId: string, actions = false) {
  if (!value || value.length > 4096) return undefined
  try {
    const url = new URL(value), prefix = `/${fullName.toLowerCase()}/`
    if (url.origin !== 'https://github.com' || url.username || url.password || url.hash
      || !url.pathname.toLowerCase().startsWith(prefix)) return undefined
    const path = url.pathname.slice(prefix.length)
    if (!(path === `runs/${nativeId}` || actions && /^actions\/runs\/[1-9]\d*(?:\/job\/[1-9]\d*)?$/.test(path))) return undefined
    if ([...url.searchParams].some(([key, item]) => key !== 'check_suite_focus' || item !== 'true')
      || [...url.searchParams].length > 1) return undefined
    return url.href
  } catch { return undefined }
}

/** Each response is a complete, bounded observation of the exact immutable
 * commit. The current person's grant is supplied by the caller; no check log
 * download URLs or installation credential fallbacks are followed. */
export async function readNativeReviewChecks(grant: GitHubPullGrant, rawHead: string, masks: Masker[]): Promise<ObservedReviewChecks> {
  const headSha = sha.parse(rawHead), root = `${grant.path}/commits/${headSha}`
  const suite = parse(z.object({ total_count: count }), (await grant.client.get(`${root}/check-suites?per_page=1`, 512 * 1024)).value)
  // GitHub's reference endpoint omits suites older than its most recent 1000.
  // Such a result is not a complete "no failures" observation.
  if (suite.total_count > 1000) throw new CodingWorkspaceError('workspace_limit_exceeded')
  const runs: z.infer<typeof checkRun>[] = [], statuses: z.infer<typeof commitStatus>[] = []
  let runTotal: number | undefined, statusTotal: number | undefined
  for (let page = 1; page <= 5; page++) {
    const reply = await grant.client.get(`${root}/check-runs?filter=latest&per_page=100&page=${page}`, 8 * 1024 * 1024)
    const value = parse(z.object({ total_count: count, check_runs: z.array(checkRun).max(100) }), reply.value)
    if (value.total_count > 500) throw new CodingWorkspaceError('workspace_limit_exceeded')
    if (runTotal !== undefined && value.total_count !== runTotal) throw unavailable()
    runTotal = value.total_count
    const remaining = runTotal - (page - 1) * 100
    if (remaining < 0 || value.check_runs.length !== Math.min(100, remaining) || reply.next !== (remaining > 100)) throw unavailable()
    if (value.check_runs.some(run => run.head_sha !== headSha || (run.status === 'completed') !== Boolean(run.conclusion))) throw unavailable()
    runs.push(...value.check_runs)
    if (!reply.next) break
  }
  for (let page = 1; page <= 5; page++) {
    const reply = await grant.client.get(`${root}/status?per_page=100&page=${page}`, 4 * 1024 * 1024)
    const value = parse(z.object({ sha, total_count: count, repository: z.object({ id, full_name: z.string() }), statuses: z.array(commitStatus).max(100) }), reply.value)
    if (value.sha !== headSha || value.repository.id !== grant.repositoryId || value.repository.full_name.toLowerCase() !== grant.fullName.toLowerCase()) throw unavailable()
    if (value.total_count > 500 || runs.length + value.total_count > 500) throw new CodingWorkspaceError('workspace_limit_exceeded')
    if (statusTotal !== undefined && value.total_count !== statusTotal) throw unavailable()
    statusTotal = value.total_count
    const remaining = statusTotal - (page - 1) * 100
    if (remaining < 0 || value.statuses.length !== Math.min(100, remaining) || reply.next !== (remaining > 100)) throw unavailable()
    statuses.push(...value.statuses)
    if (!reply.next) break
  }
  if (runs.length !== runTotal || statuses.length !== statusTotal || new Set(runs.map(run => run.id)).size !== runs.length
    || new Set(statuses.map(status => status.id)).size !== statuses.length || new Set(statuses.map(status => status.context)).size !== statuses.length) throw unavailable()
  const mask = (value: string) => masks.reduce((value, redact) => redact(value), value)
  let excerptBudget = 64_000
  const project = (kind: 'check_run' | 'commit_status', nativeId: string, rawName: string, status: z.infer<typeof observedReviewCheck>['status'],
    conclusion: string | null, rawLog: string, stamp: string | null, rawUrl?: string) => {
    // Redact complete provider text before either excerpt or name truncation.
    const name = mask(rawName), log = mask(rawLog), limit = status === 'failed' ? Math.min(2000, excerptBudget) : 0
    const logExcerpt = log.slice(0, limit); excerptBudget -= logExcerpt.length
    return observedReviewCheck.parse({ nativeId, kind, name: name.slice(0, 200), nameTruncated: name.length > 200, status, conclusion,
      logExcerpt, logTruncated: logExcerpt.length < log.length, ...(rawUrl ? { logUrl: rawUrl } : {}), detailDigest: diffDigest(JSON.stringify([name, log, stamp])) })
  }
  const checks = [
    ...runs.sort((a, b) => a.id.localeCompare(b.id)).map(run => project('check_run', run.id, run.name,
      run.status !== 'completed' ? 'pending' : run.conclusion === 'success' ? 'passed'
        : ['neutral', 'skipped'].includes(run.conclusion!) ? 'neutral' : 'failed', run.conclusion,
      [run.output?.title, run.output?.summary, run.output?.text].filter(value => value != null).join('\n\n'), JSON.stringify([run.status, run.completed_at]),
      nativeCheckUrl(run.html_url ? mask(run.html_url) : undefined, grant.fullName, run.id, true)
        ?? nativeCheckUrl(run.details_url ? mask(run.details_url) : undefined, grant.fullName, run.id))),
    ...statuses.sort((a, b) => a.id.localeCompare(b.id)).map(status => project('commit_status', status.id, status.context,
      status.state === 'success' ? 'passed' : status.state === 'pending' ? 'pending' : 'failed', status.state, status.description ?? '', status.updated_at)),
  ]
  const counts = { total: checks.length, failed: 0, passed: 0, pending: 0, neutral: 0 }
  for (const check of checks) counts[check.status]++
  return observedReviewChecks.parse({ repositoryId: grant.repositoryId, headSha, observedAt: new Date().toISOString(), checks, counts,
    fingerprint: diffDigest(JSON.stringify([grant.repositoryId, headSha, checks])) })
}
