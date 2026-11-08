import 'server-only'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { CodingWorkspaceError, visibleWorkspacePath } from '@mikka/protocol/coding-workspace'
import { reviewAnchor, WorkspaceReviewError, type DiffSnapshot, type ReviewAnchor } from '@mikka/protocol/coding-workspace-review'
import { githubTokenForUser, GitHubAccessError } from '../../github/user-access'
import { githubRepository } from '../../github/run-pull-request'
import type { RequestBudget } from '../../request-budget'
import { diffDigest } from './patch'
import { GitHubDiffClient } from './github-api'
import { readGitHubPull, type GitHubPullGrant } from './github'

const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
const id = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String), z.string().regex(/^[1-9]\d{0,39}$/)])
const body = z.string().max(16_000)
export const nativeReviewWrite = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('github_review'), event: z.enum(['COMMENT', 'REQUEST_CHANGES', 'APPROVE']), note: body,
    comments: z.array(z.strictObject({ id: z.uuid(), anchor: reviewAnchor, body: z.string().min(1).max(4000) })).max(50) }),
  z.strictObject({ kind: z.literal('github_reply'), commentId: id, body: z.string().min(1).max(4000) }),
])
export type NativeReviewWrite = z.infer<typeof nativeReviewWrite>
export type NativeReviewGrant = GitHubPullGrant & { githubAccountId: string; verifyCredential?: (client: PoolClient) => Promise<void> }
export type NativeReviewReceipt = { kind: NativeReviewWrite['kind']; id: string; url: string; headSha: string; commitSha: string; outdated?: boolean; evidenceDigest: string }
const unavailable = () => new WorkspaceReviewError('workspace_review_github_unavailable')
const outdated = () => new WorkspaceReviewError('workspace_snapshot_outdated')
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw unavailable()
  return result.data
}

/** Native writes always use the connected person's own /user-verified token.
 * An installation credential never substitutes for a missing user identity. */
export async function nativeReviewUserGrant(userId: string, repositoryKey: string, repositoryId: string,
  budget: RequestBudget, prepared?: Awaited<ReturnType<typeof githubTokenForUser>>): Promise<NativeReviewGrant> {
  try {
    const credential = prepared ?? await githubTokenForUser(userId, { minValidityMs: 45_000, budget })
    const repo = githubRepository(repositoryKey), client = new GitHubDiffClient(credential.token, budget)
    const current = parse(z.object({ id, full_name: z.string() }), (await client.get(repo.path, 512 * 1024)).value)
    if (current.id !== repositoryId || current.full_name.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase())
      throw new WorkspaceReviewError('workspace_review_github_forbidden')
    return { client, repositoryId, path: repo.path, fullName: current.full_name, githubAccountId: credential.githubAccountId,
      verifyCredential: async tx => {
        const connected = await tx.query<{ githubAccountId: string; accessToken: string; valid: boolean }>(`SELECT "githubAccountId","accessToken",
          ("accessTokenExpiresAt" IS NULL OR "accessTokenExpiresAt">clock_timestamp()) AS valid
          FROM github_connections WHERE "userId"=$1 FOR SHARE`, [userId])
        const legacy = connected.rows.length ? null : await tx.query<{ accountId: string; accessToken: string }>(`SELECT "accountId","accessToken"
          FROM account WHERE "userId"=$1 AND "providerId"='github' AND ("accessTokenExpiresAt" IS NULL OR "accessTokenExpiresAt">clock_timestamp()) FOR SHARE`, [userId])
        const row = connected.rows[0], old = legacy?.rows[0]
        if (row ? !row.valid || row.githubAccountId !== credential.githubAccountId : !old || legacy!.rows.length !== 1 || old.accountId !== credential.githubAccountId)
          throw new WorkspaceReviewError('workspace_review_github_forbidden')
        const { unsealGitHubSecret } = await import('../../github/connection')
        let token: string
        try { token = await unsealGitHubSecret(row?.accessToken ?? old!.accessToken) }
        // error-cause: decryption errors can include the stored credential ciphertext.
        catch { throw new WorkspaceReviewError('workspace_review_github_forbidden') }
        if (token !== credential.token) throw new WorkspaceReviewError('workspace_review_github_forbidden')
      } }
  } catch (error) {
    if (error instanceof GitHubAccessError) throw new WorkspaceReviewError(['githubUnavailable', 'githubNotConfigured'].includes(error.code)
      ? 'workspace_review_github_unavailable' : 'workspace_review_github_forbidden', { cause: error })
    if (error instanceof CodingWorkspaceError || error instanceof WorkspaceReviewError) throw error
    // error-cause: credential-provider failures can contain tokens or raw provider bodies.
    throw unavailable()
  }
}

function target(grant: NativeReviewGrant, snapshot: DiffSnapshot) {
  if (snapshot.revision.source !== 'pull_request' || !snapshot.pullRequest || !snapshot.revision.headSha || !snapshot.pullRequest.baseSha
    || snapshot.sourceAccess?.repositoryId !== grant.repositoryId || snapshot.sourceAccess.pullRequestNumber !== snapshot.pullRequest.number)
    throw new WorkspaceReviewError('workspace_snapshot_unavailable')
  return { number: snapshot.pullRequest.number, head: snapshot.revision.headSha, base: snapshot.pullRequest.baseSha,
    url: `https://github.com/${grant.fullName}/pull/${snapshot.pullRequest.number}`,
    api: `https://api.github.com${grant.path}/pulls/${snapshot.pullRequest.number}` }
}
const markerFor = (batchId: string, fingerprint: string) => {
  z.uuid().parse(batchId); z.string().regex(/^[a-f0-9]{64}$/).parse(fingerprint)
  return `<!-- mikka-workspace-review:${batchId}:${fingerprint} -->`
}

/** The marker is derived from the first durable batch, not a retry request ID. */
export function nativeReviewPayload(write: NativeReviewWrite, snapshot: DiffSnapshot, batchId: string, fingerprint: string): Record<string, unknown> {
  write = nativeReviewWrite.parse(write)
  const marker = markerFor(batchId, fingerprint)
  if (write.kind === 'github_reply') return { body: `${write.body}\n\n${marker}` }
  if (!snapshot.revision.headSha) throw outdated()
  const comments = write.comments.map(item => {
    const anchor: ReviewAnchor = item.anchor
    if (anchor.snapshotId !== snapshot.id || anchor.sourceVersion !== snapshot.revision.version || !visibleWorkspacePath(anchor.path)) throw outdated()
    return { path: anchor.path, body: item.body, line: anchor.lineEnd, side: anchor.side,
      ...(anchor.lineStart !== anchor.lineEnd ? { start_line: anchor.lineStart, start_side: anchor.side } : {}) }
  })
  return { commit_id: snapshot.revision.headSha, event: write.event,
    body: `${write.note || `Mikka inline review (${comments.length} comments).`}\n\n${marker}`, comments }
}

export async function verifyNativeReviewTarget(grant: NativeReviewGrant, snapshot: DiffSnapshot, write: NativeReviewWrite) {
  const bound = target(grant, snapshot), current = await readGitHubPull(grant, bound.number)
  if (current.head.sha !== bound.head || current.base.sha !== bound.base) throw outdated()
  if (write.kind === 'github_review' && (current.state !== 'open' || current.merged)) throw outdated()
  if (write.kind === 'github_reply') {
    const parent = parse(z.object({ id, pull_request_url: z.string(), in_reply_to_id: id.nullish(),
      path: z.string(), original_commit_id: sha }), (await grant.client.get(`${grant.path}/pulls/comments/${write.commentId}`, 1024 * 1024)).value)
    if (parent.id !== write.commentId || parent.in_reply_to_id || parent.pull_request_url.toLowerCase() !== bound.api.toLowerCase())
      throw new WorkspaceReviewError('workspace_review_unavailable')
    if (!visibleWorkspacePath(parent.path)) throw new CodingWorkspaceError('workspace_path_unavailable')
  }
}

function receiptFrom(grant: NativeReviewGrant, snapshot: DiffSnapshot, write: NativeReviewWrite, payload: Record<string, unknown>,
  value: unknown): NativeReviewReceipt {
  const bound = target(grant, snapshot)
  const receipt = parse(z.object({ id, body: z.string(), user: z.object({ id }), html_url: z.string(),
    pull_request_url: z.string(), commit_id: sha, state: z.string().optional(), submitted_at: z.iso.datetime().nullable().optional(),
    in_reply_to_id: id.nullish() }), value)
  const url = `${bound.url}#${write.kind === 'github_review' ? 'pullrequestreview-' : 'discussion_r'}${receipt.id}`
  if (receipt.user.id !== grant.githubAccountId || receipt.body !== payload.body || receipt.html_url.toLowerCase() !== url.toLowerCase()
    || receipt.pull_request_url.toLowerCase() !== bound.api.toLowerCase()) throw unavailable()
  if (write.kind === 'github_review') {
    const expectedState = { COMMENT: 'COMMENTED', REQUEST_CHANGES: 'CHANGES_REQUESTED', APPROVE: 'APPROVED' }[write.event]
    if (receipt.state !== expectedState || !receipt.submitted_at || receipt.commit_id !== bound.head) throw unavailable()
  } else if (receipt.in_reply_to_id !== write.commentId) throw unavailable()
  return { kind: write.kind, id: receipt.id, url, headSha: bound.head, commitSha: receipt.commit_id,
    evidenceDigest: diffDigest(JSON.stringify([grant.repositoryId, grant.githubAccountId, bound.number, write.kind, receipt.id, receipt.commit_id, payload])) }
}

/** A review-level marker proves only the review body. Its complete inline
 * multiset must also match before recovering a batch as delivered. Original
 * coordinates remain the evidence when GitHub relocates a current thread. */
async function inlineReceiptMatches(grant: NativeReviewGrant, snapshot: DiffSnapshot, write: NativeReviewWrite, reviewId: string) {
  if (write.kind !== 'github_review') return true
  const bound = target(grant, snapshot)
  const expected = write.comments.map(item => JSON.stringify([item.anchor.path, item.body, item.anchor.side,
    item.anchor.lineEnd, item.anchor.lineStart !== item.anchor.lineEnd ? item.anchor.lineStart : null,
    item.anchor.lineStart !== item.anchor.lineEnd ? item.anchor.side : null])).sort()
  const detail = z.object({ id, pull_request_review_id: id, user: z.object({ id }), pull_request_url: z.string(),
    body: z.string(), path: z.string(), side: z.enum(['LEFT', 'RIGHT']), start_side: z.enum(['LEFT', 'RIGHT']).nullish(),
    original_line: z.number().int().positive().nullable(), original_start_line: z.number().int().positive().nullable(),
    original_commit_id: sha, in_reply_to_id: id.nullish() })
  const actual: string[] = [], seen = new Set<string>()
  let complete = false
  // The PR comments endpoint documents modern original line/side fields.
  // Review-specific comment listings may expose only legacy positions.
  for (let page = 1; page <= 10; page++) {
    const result = await grant.client.get(`${grant.path}/pulls/${bound.number}/comments?per_page=100&page=${page}`)
    const rows = z.array(z.object({ id, pull_request_review_id: id.nullable(), in_reply_to_id: id.nullish() }).passthrough()).max(100).safeParse(result.value)
    if (!rows.success) return false
    for (const value of rows.data) {
      if (seen.has(value.id)) return false
      seen.add(value.id)
      if (value.pull_request_review_id !== reviewId || value.in_reply_to_id) continue
      const parsed = detail.safeParse(value)
      if (!parsed.success) return false
      const item = parsed.data
      if (item.user.id !== grant.githubAccountId || item.pull_request_url.toLowerCase() !== bound.api.toLowerCase()
        || item.original_commit_id !== bound.head || item.original_line === null) return false
      actual.push(JSON.stringify([item.path, item.body, item.side, item.original_line, item.original_start_line,
        item.original_start_line === null ? null : item.start_side ?? null]))
    }
    if (actual.length > expected.length) return false
    if (!result.next) { complete = true; break }
    if (rows.data.length !== 100) return false
  }
  if (!complete || actual.length !== expected.length) return false
  actual.sort()
  return actual.every((entry, index) => entry === expected[index])
}

/** Called exactly once by operation_ledger.invoke. Any thrown error after
 * beforeSend may represent an accepted write; never re-enter this function. */
export async function publishNativeGitHubReview(grant: NativeReviewGrant, snapshot: DiffSnapshot, write: NativeReviewWrite,
  batchId: string, fingerprint: string, beforeSend: () => Promise<void>): Promise<NativeReviewReceipt> {
  const bound = target(grant, snapshot), payload = nativeReviewPayload(write, snapshot, batchId, fingerprint)
  await verifyNativeReviewTarget(grant, snapshot, write)
  await beforeSend()
  const value = await grant.client.post(`${grant.path}/pulls/${bound.number}/${write.kind === 'github_review' ? 'reviews' : `comments/${write.commentId}/replies`}`, payload)
  const receipt = receiptFrom(grant, snapshot, write, payload, value)
  if (!await inlineReceiptMatches(grant, snapshot, write, receipt.id)) throw unavailable()
  // An accepted review remains attached to its captured commit even if the PR
  // moved during the call. Failure to read back is not proof of an unchanged head.
  try {
    const current = await readGitHubPull(grant, bound.number)
    receipt.outdated = current.head.sha !== bound.head || current.base.sha !== bound.base
  } catch { /* The accepted receipt is still authoritative; head state is unknown. */ }
  return receipt
}

/** Positive, unique, complete readback only. A missing marker cannot prove
 * that an older in-flight POST will not eventually complete. */
export async function reconcileNativeGitHubReview(grant: NativeReviewGrant, snapshot: DiffSnapshot, write: NativeReviewWrite,
  batchId: string, fingerprint: string): Promise<NativeReviewReceipt | null> {
  const bound = target(grant, snapshot), payload = nativeReviewPayload(write, snapshot, batchId, fingerprint)
  const matches: NativeReviewReceipt[] = []
  for (let page = 1; page <= 10; page++) {
    const result = await grant.client.get(`${grant.path}/pulls/${bound.number}/${write.kind === 'github_review' ? 'reviews' : 'comments'}?per_page=100&page=${page}`)
    const rows = parse(z.array(z.object({ body: z.string().nullable() }).passthrough()).max(100), result.value)
    for (const row of rows) if (row.body === payload.body) {
      try {
        const receipt = receiptFrom(grant, snapshot, write, payload, row)
        if (!await inlineReceiptMatches(grant, snapshot, write, receipt.id)) return null
        matches.push(receipt)
      }
      catch { return null }
    }
    if (matches.length > 1) return null
    if (!result.next) return matches[0] ?? null
    if (rows.length !== 100) throw unavailable()
  }
  return null
}
