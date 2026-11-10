import { z } from 'zod'
import { PublicationError } from '@/lib/run-publication-result'

export type ReviewCheckState = 'passed' | 'failed' | 'pending' | 'skipped'
export type ReviewCheck = { id: number; state: ReviewCheckState; at: string }
export type ReviewChecks = { headSha: string; complete: boolean; updatedAt: string; entries: Record<string, ReviewCheck> }
export type ReviewCheckCounts = Record<ReviewCheckState, number>
const sha = z.string().regex(/^[a-f0-9]{40,64}$/i)
const id = z.number().int().positive().refine(Number.isSafeInteger)
const timestamp = z.iso.datetime({ offset: true })
const run = z.object({ id, name: z.string().min(1).max(512), head_sha: sha, app: z.object({ id }), check_suite: z.object({ id }),
  status: z.string(), conclusion: z.string().nullable(), started_at: timestamp.nullable(), completed_at: timestamp.nullable() })
const status = z.object({ id, context: z.string().min(1).max(512), state: z.enum(['error', 'failure', 'pending', 'success']), updated_at: timestamp })
const snapshot = z.object({ headSha: sha, complete: z.boolean(), updatedAt: timestamp,
  entries: z.record(z.string(), z.object({ id, state: z.enum(['passed', 'failed', 'pending', 'skipped']), at: timestamp })) })

function checkState(value: z.infer<typeof run>): ReviewCheckState {
  if (value.status !== 'completed' || !value.conclusion) return 'pending'
  if (value.conclusion === 'success') return 'passed'
  if (['neutral', 'skipped'].includes(value.conclusion)) return 'skipped'
  return 'failed'
}
const checkKey = (value: z.infer<typeof run>) => JSON.stringify(['check', value.app.id, value.check_suite.id, value.name])
const statusKey = (value: z.infer<typeof status>) => JSON.stringify(['status', value.context])
const statusState = (value: z.infer<typeof status>): ReviewCheckState => value.state === 'success' ? 'passed' : value.state === 'pending' ? 'pending' : 'failed'
function parse<T>(schema: z.ZodType<T>, value: unknown) {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new PublicationError('github_request_failed')
  return parsed.data
}

/** Publication ingestion only. A bounded, complete snapshot; a partial page or
 * inaccessible checks source is unknown, never zero checks or a green result. */
export async function readReviewChecks(request: (path: string) => Promise<unknown>, path: string, headSha: string): Promise<ReviewChecks> {
  parse(sha, headSha)
  const entries: Record<string, ReviewCheck> = {}
  const observedAt = new Date().toISOString()
  for (const source of ['checks', 'statuses'] as const) {
    let read = 0, complete = false
    for (let page = 1; page <= 10; page++) {
      const suffix = source === 'checks' ? 'check-runs?filter=all&' : 'status?'
      const raw = await request(`${path}/commits/${headSha}/${suffix}per_page=100&page=${page}`)
      if (source === 'checks') {
        const result = parse(z.object({ total_count: z.number().int().nonnegative(), check_runs: z.array(run).max(100) }), raw)
        for (const item of result.check_runs) {
          if (item.head_sha.toLowerCase() !== headSha.toLowerCase()) throw new PublicationError('github_request_failed')
          const key = checkKey(item)
          if (!entries[key] || entries[key].id < item.id) entries[key] = { id: item.id, state: checkState(item), at: new Date(item.completed_at ?? item.started_at ?? observedAt).toISOString() }
        }
        read += result.check_runs.length
        complete = read >= result.total_count
        if (!complete && !result.check_runs.length) break
      } else {
        const result = parse(z.object({ sha, total_count: z.number().int().nonnegative(), statuses: z.array(status).max(100) }), raw)
        if (result.sha.toLowerCase() !== headSha.toLowerCase()) throw new PublicationError('github_request_failed')
        for (const item of result.statuses) {
          const key = statusKey(item)
          if (!entries[key] || entries[key].id < item.id) entries[key] = { id: item.id, state: statusState(item), at: new Date(item.updated_at).toISOString() }
        }
        read += result.statuses.length
        complete = read >= result.total_count
        if (!complete && !result.statuses.length) break
      }
      if (complete) break
    }
    if (!complete) throw new PublicationError('github_request_failed')
  }
  return { headSha: headSha.toLowerCase(), complete: true, updatedAt: new Date().toISOString(), entries }
}

/** Safe public projection of the persisted cache. Internal check names/ids and
 * older-head results never cross into the approval summary. */
export function reviewCheckCounts(value: unknown, headSha: string | null): { counts: ReviewCheckCounts | null; updatedAt: string | null } {
  const parsed = snapshot.safeParse(value)
  if (!parsed.success || !headSha || parsed.data.headSha !== headSha) return { counts: null, updatedAt: null }
  const result = parsed.data
  if (!result.complete) return { counts: null, updatedAt: result.updatedAt }
  const counts = { passed: 0, failed: 0, pending: 0, skipped: 0 }
  for (const item of Object.values(result.entries)) counts[item.state]++
  return { counts, updatedAt: result.updatedAt }
}

/** Called only after signature verification; metadata admits no token or URL. */
export function reviewCheckEvent(event: string, payload: unknown) {
  const repository = z.object({ full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/) })
  if (event === 'check_run') {
    const parsed = z.object({ action: z.enum(['created', 'completed']), repository, check_run: run }).safeParse(payload)
    if (!parsed.success) return null
    const item = parsed.data.check_run, at = item.completed_at ?? item.started_at ?? new Date().toISOString()
    return { repository: parsed.data.repository.full_name, headSha: item.head_sha.toLowerCase(), key: checkKey(item),
      check: { id: item.id, state: checkState(item), at: new Date(at).toISOString() } }
  }
  if (event === 'status') {
    const parsed = status.extend({ repository, sha }).safeParse(payload)
    if (!parsed.success) return null
    return { repository: parsed.data.repository.full_name, headSha: parsed.data.sha.toLowerCase(), key: statusKey(parsed.data),
      check: { id: parsed.data.id, state: statusState(parsed.data), at: new Date(parsed.data.updated_at).toISOString() } }
  }
  return null
}
