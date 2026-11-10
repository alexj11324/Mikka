import 'server-only'
import { isDeepStrictEqual } from 'node:util'
import type { Pool } from 'pg'
import { z } from 'zod'
import { normalizeRepository } from '@mikka/protocol/repository'
import { CodingWorkspaceError, workspacePath } from '@mikka/protocol/coding-workspace'
import { WORKSPACE_DIFF_MAX_BLOB_BYTES, WorkspaceReviewError, type DiffSnapshot,
  type DiffSourceAccess } from '@mikka/protocol/coding-workspace-review'
import { githubRepositoryReadCredential, GitHubAccessError } from '../../github/user-access'
import { githubRepository } from '../../github/run-pull-request'
import { CloudServiceError } from '../../cloud-services/errors'
import { remainingRequestBudget, type RequestBudget } from '../../request-budget'
import type { ReviewScope } from './authority'
import type { ExternalDiffProvider } from './service'
import { manifestRevision } from './store'
import { buildDiffFilePatch, diffDigest, gitBlobHash } from './patch'
import { buildGitHubFilePatch } from './github-patch'
import { buildGitHubManifest, parseGitHubTree, type GitHubNativeFile } from './github-manifest'
import { GitHubDiffClient } from './github-api'
import { readGitHubPullState } from './github-state'

const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
const id = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String), z.string().regex(/^[1-9]\d{0,39}$/)])
const commitSchema = z.object({ sha, tree: z.object({ sha }) })
const pullSchema = z.object({ number: z.number().int().positive(), html_url: z.string(),
  state: z.enum(['open', 'closed']), merged: z.boolean(), changed_files: z.number().int().nonnegative(),
  base: z.object({ sha, repo: z.object({ id, full_name: z.string() }) }), head: z.object({ sha }) })
type Pull = z.infer<typeof pullSchema>
export type GitHubPullGrant = { client: GitHubDiffClient; repositoryId: string; path: string; fullName: string }
const nativeSchema = z.object({ filename: workspacePath.refine(Boolean), previous_filename: workspacePath.optional(),
  status: z.enum(['added', 'removed', 'modified', 'renamed']), sha,
  additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), patch: z.string().optional() })
type Association = { number: number; factory?: DiffSnapshot['factory'] }
const unavailable = () => new WorkspaceReviewError('workspace_snapshot_unavailable')
const outdated = () => new WorkspaceReviewError('workspace_snapshot_outdated')
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw unavailable()
  return parsed.data
}
export async function readGitHubPull(grant: GitHubPullGrant, number: number): Promise<Pull> {
  const value = parse(pullSchema, (await grant.client.get(`${grant.path}/pulls/${number}`, 512 * 1024)).value)
  if (value.number !== number || value.base.repo.id !== grant.repositoryId
    || value.base.repo.full_name.toLowerCase() !== grant.fullName.toLowerCase()
    || value.html_url.toLowerCase() !== `https://github.com/${grant.fullName}/pull/${number}`.toLowerCase()) throw unavailable()
  return value
}
async function together<T>(promises: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises)
  const failed = results.find(result => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  return results.map(result => (result as PromiseFulfilledResult<T>).value)
}
function publishedNumber(value: unknown, key: string): number {
  const url = value && typeof value === 'object' && 'url' in value ? value.url : null
  const match = typeof url === 'string' ? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url) : null
  if (!match || `v2/github.com/${match[1]!.toLowerCase()}` !== key || !Number.isSafeInteger(Number(match[2]))) throw unavailable()
  return Number(match[2])
}
function candidateRepository(value: string): string {
  try {
    if (value.startsWith('v2/')) { githubRepository(value); return value }
    return normalizeRepository(/^[\w.-]+\/[\w.-]+$/.test(value) ? `https://github.com/${value}.git` : value).key
  // error-cause: repository parsing errors can include a credential-bearing remote URL.
  } catch { throw unavailable() }
}

/** Resolve only this Run's host publication, or its original Factory
 * candidate. A Task's newest PR or newest candidate is not this Run's source. */
export async function associatedGitHubPull(database: Pick<Pool, 'query'>, scope: ReviewScope): Promise<Association> {
  if (!scope.taskId) throw unavailable()
  const { runId, ownerId, repositoryKey: canonicalKey } = scope.identity
  const [direct, related] = await Promise.all([
    database.query<{ pullRequest: unknown }>(`SELECT p."pullRequest" FROM run_publications p
      JOIN agent_runs r ON r.id=p."runId" AND r."userId"=p."userId" AND r."issueId"=p."issueId"
      WHERE r.id=$1 AND r."userId"=$2 AND r."issueId"=$3 AND p."remoteKey"=$4 AND p.status='published'`,
    [runId, ownerId, scope.taskId, canonicalKey]),
    database.query<{ id: string; taskId: string; runId: string; sha: string | null; kind: string; repository: string;
      pullRequest: unknown; skill: boolean }>(`WITH related AS (
        SELECT c.* FROM factory_candidates c WHERE c."runId"=$1
        UNION SELECT c.* FROM factory_attempts a JOIN factory_candidates c ON c.id=a."candidateId" AND c."taskId"=a."taskId" WHERE a."runId"=$1
      ) SELECT c.id,c."taskId",c."runId",c.sha,c.kind,c.repository,p."pullRequest",
        EXISTS(SELECT 1 FROM improvement_skill_candidates s WHERE s."candidateId"=c.id) AS skill
      FROM related c JOIN factory_tasks t ON t.id=c."taskId" AND t."userId"=$2 AND t."issueId"=$3
      JOIN agent_runs producer ON producer.id=c."runId" AND producer."userId"=t."userId" AND producer."issueId"=t."issueId"
      LEFT JOIN run_publications p ON p."runId"=producer.id AND p."userId"=producer."userId" AND p."issueId"=t."issueId"
        AND p."remoteKey"=$4 AND p.status='published'`, [runId, ownerId, scope.taskId, canonicalKey]),
  ])
  if (direct.rows.length > 1 || related.rows.length > 1) throw unavailable()
  const candidate = related.rows[0]
  const number = direct.rows[0] ? publishedNumber(direct.rows[0].pullRequest, canonicalKey) : undefined
  if (!candidate) {
    if (!number) throw unavailable()
    return { number }
  }
  if (candidate.skill || candidate.kind !== 'repository' || !sha.safeParse(candidate.sha).success
    || candidateRepository(candidate.repository) !== canonicalKey) throw unavailable()
  const candidateNumber = publishedNumber(candidate.pullRequest, canonicalKey)
  if (number !== undefined && number !== candidateNumber) throw unavailable()
  return { number: candidateNumber, factory: { taskId: candidate.taskId, candidateId: candidate.id,
    producerRunId: candidate.runId, sha: candidate.sha! } }
}

/** Each HTTP request creates its own provider bound to the actual viewer.
 * The Run owner is used only for immutable publication lookup, never tokens. */
export function githubDiffProvider(database: Pool, userId: string, signal?: AbortSignal): ExternalDiffProvider {
  const budget: RequestBudget = { deadline: Date.now() + 30_000, signal }
  const checkBudget = () => {
    try { remainingRequestBudget(budget) } catch (cause) { throw new WorkspaceReviewError('workspace_review_github_unavailable', { cause }) }
  }
  const credentials = new Map<string, Promise<{ client: GitHubDiffClient; repositoryId: string; path: string; fullName: string }>>()
  const observations = new Map<string, { stale: boolean }>()
  const access = (scope: ReviewScope) => {
    checkBudget()
    const key = scope.identity.repositoryKey
    let pending = credentials.get(key)
    if (!pending) {
      pending = (async () => {
        try {
          const credential = await githubRepositoryReadCredential(userId, key, budget)
          const repo = githubRepository(key)
          return { client: new GitHubDiffClient(credential.token, budget), repositoryId: credential.repository.id,
            path: repo.path, fullName: credential.repository.fullName }
        } catch (error) {
          if (error instanceof GitHubAccessError)
            throw new WorkspaceReviewError(['githubUnavailable', 'githubNotConfigured'].includes(error.code)
              ? 'workspace_review_github_unavailable' : 'workspace_review_github_forbidden', { cause: error })
          if (error instanceof CloudServiceError)
            throw new WorkspaceReviewError(error.code === 'cloud_unavailable' ? 'workspace_review_github_unavailable' : 'workspace_review_github_forbidden', { cause: error })
          // error-cause: credential provider failures can contain tokens or raw provider bodies.
          throw new WorkspaceReviewError('workspace_review_github_unavailable')
        }
      })()
      credentials.set(key, pending)
    }
    return pending
  }
  type Access = Awaited<ReturnType<typeof access>>
  async function pull(grant: Access, number: number): Promise<Pull> {
    return readGitHubPull(grant, number)
  }
  async function tree(grant: Access, commit: string) {
    const value = parse(commitSchema, (await grant.client.get(`${grant.path}/git/commits/${commit}`, 512 * 1024)).value)
    if (value.sha !== commit) throw unavailable()
    return parseGitHubTree((await grant.client.get(`${grant.path}/git/trees/${value.tree.sha}?recursive=1`, 7 * 1024 * 1024)).value, value.tree.sha)
  }
  function nativeFiles(value: unknown, page: number): { file: GitHubNativeFile; patch: string | null }[] {
    const files = parse(z.array(nativeSchema).max(100), value)
    return files.map(file => ({ file: { path: file.filename, previousPath: file.previous_filename ?? null,
      status: file.status, sha: file.sha, additions: file.additions, deletions: file.deletions,
      patchSha256: file.patch === undefined ? null : diffDigest(file.patch), page }, patch: file.patch ?? null }))
  }
  async function blob(grant: Access, object: string | null, size: number | null | undefined): Promise<Buffer | null> {
    if (object === null) return null
    if (size === null || size === undefined || size > WORKSPACE_DIFF_MAX_BLOB_BYTES) throw unavailable()
    const value = parse(z.object({ sha, size: z.number().int().nonnegative(), encoding: z.literal('base64'), content: z.string() }),
      (await grant.client.get(`${grant.path}/git/blobs/${object}`, Math.ceil(WORKSPACE_DIFF_MAX_BLOB_BYTES / 3) * 4 + 32 * 1024)).value)
    const content = value.content.replace(/[\r\n]/g, ''), bytes = Buffer.from(content, 'base64')
    if (value.sha !== object || value.size !== size || bytes.length !== size || bytes.toString('base64') !== content
      || gitBlobHash(bytes, object) !== object) throw unavailable()
    return bytes
  }
  const verify: ExternalDiffProvider['verify'] = async (scope, snapshot) => {
    const grant = await access(scope)
    if (snapshot.sourceAccess?.repositoryId !== grant.repositoryId) throw new WorkspaceReviewError('workspace_review_github_forbidden')
    let stale = false
    if (snapshot.pullRequest) {
      const associated = await associatedGitHubPull(database, scope)
      if (associated.number !== snapshot.pullRequest.number || !isDeepStrictEqual(associated.factory, snapshot.factory)) throw outdated()
      const current = await pull(grant, snapshot.pullRequest.number)
      stale = current.head.sha !== snapshot.revision.headSha || current.base.sha !== snapshot.pullRequest.baseSha
    } else if (snapshot.revision.source !== 'commit') throw unavailable()
    observations.set(snapshot.id, { stale })
    return { isStale: stale }
  }
  return {
    verify,
    async pullState(scope, snapshot) { return readGitHubPullState(await access(scope), snapshot) },
    async capture(scope, selection) {
      const grant = await access(scope)
      let baseSha: string, headSha: string, sourceAccess: DiffSourceAccess, associated: Association | undefined, current: Pull | undefined
      const files: GitHubNativeFile[] = []
      if (selection.source === 'commit') {
        baseSha = selection.baseSha; headSha = selection.headSha
        sourceAccess = { kind: 'github', repositoryId: grant.repositoryId, manifestComplete: true }
      } else {
        associated = await associatedGitHubPull(database, scope)
        current = await pull(grant, associated.number)
        if (associated.factory && associated.factory.sha !== current.head.sha) throw outdated()
        if (current.changed_files > 3000) throw new CodingWorkspaceError('workspace_limit_exceeded')
        headSha = current.head.sha
        const comparison = parse(z.object({ base_commit: z.object({ sha }), merge_base_commit: z.object({ sha }) }),
          (await grant.client.get(`${grant.path}/compare/${current.base.sha}...${headSha}?per_page=1`, 4 * 1024 * 1024)).value)
        if (comparison.base_commit.sha !== current.base.sha) throw unavailable()
        baseSha = comparison.merge_base_commit.sha
        const pages = Math.max(1, Math.ceil(current.changed_files / 100))
        for (let page = 1; page <= pages; page++) {
          const result = await grant.client.get(`${grant.path}/pulls/${associated.number}/files?per_page=100&page=${page}`)
          const entries = nativeFiles(result.value, page)
          if (entries.length !== Math.min(100, current.changed_files - (page - 1) * 100)
            || result.next !== (page < pages)) throw unavailable()
          files.push(...entries.map(entry => entry.file))
        }
        sourceAccess = { kind: 'github', repositoryId: grant.repositoryId, pullRequestNumber: associated.number,
          pullRequestBaseSha: current.base.sha, manifestComplete: true }
      }
      const [before, after] = await together([tree(grant, baseSha), tree(grant, headSha)])
      const manifest = buildGitHubManifest({ repoId: scope.identity.repoId, repositoryId: grant.repositoryId, baseSha, headSha,
        before: before!, after: after!, ...(current ? { nativeFiles: files } : {}) })
      if (current && associated) {
        const last = await pull(grant, associated.number)
        if (last.head.sha !== headSha || last.base.sha !== current.base.sha || last.changed_files !== current.changed_files
          || !isDeepStrictEqual(await associatedGitHubPull(database, scope), associated)) throw outdated()
      }
      checkBudget()
      return { revision: manifestRevision(selection.source, baseSha, headSha, null, manifest, sourceAccess), files: manifest, sourceAccess,
        ...(current && associated ? { pullRequest: { number: associated.number, url: `https://github.com/${grant.fullName}/pull/${associated.number}`,
          headSha, baseSha: current.base.sha, state: current.merged ? 'merged' as const : current.state }, ...(associated.factory ? { factory: associated.factory } : {}) } : {}) }
    },
    async file(scope, snapshot, file, mask) {
      const grant = await access(scope)
      if (!observations.has(snapshot.id)) await verify(scope, snapshot)
      if (snapshot.sourceAccess?.repositoryId !== grant.repositoryId || file.github?.repositoryId !== grant.repositoryId) throw unavailable()
      if (snapshot.pullRequest && observations.get(snapshot.id)?.stale) throw outdated()
      const empty = (format: 'unavailable' | 'too_large') => ({ snapshotId: snapshot.id, sourceVersion: snapshot.revision.version,
        file, format, patch: null, hunks: [] })
      if ([file.oldMode, file.newMode].some(mode => mode !== null && !['100644', '100755'].includes(mode))) return empty('unavailable')
      if ([file.oldSize, file.newSize].some(size => size != null && size > WORKSPACE_DIFF_MAX_BLOB_BYTES)) return empty('too_large')
      let nativePatch: string | null = null
      if (snapshot.pullRequest) {
        if (!file.github?.page) throw unavailable()
        const entries = nativeFiles((await grant.client.get(`${grant.path}/pulls/${snapshot.pullRequest.number}/files?per_page=100&page=${file.github.page}`)).value, file.github.page)
        const matches = entries.filter(entry => entry.file.path === file.path)
        const selected = matches[0]
        if (matches.length !== 1 || !selected || selected.file.sha !== (file.newBlob ?? file.oldBlob)
          || selected.file.previousPath !== file.previousPath || (selected.file.status === 'removed' ? 'deleted' : selected.file.status) !== file.status
          || selected.file.patchSha256 !== file.github.patchSha256) throw outdated()
        nativePatch = selected.patch
      }
      const [before, after] = await together([blob(grant, file.oldBlob, file.oldSize), blob(grant, file.newBlob, file.newSize)])
      if (snapshot.pullRequest) {
        const current = await pull(grant, snapshot.pullRequest.number)
        if (current.head.sha !== snapshot.revision.headSha || current.base.sha !== snapshot.pullRequest.baseSha) throw outdated()
      }
      checkBudget()
      const input = { snapshotId: snapshot.id, sourceVersion: snapshot.revision.version, file, before: before!, after: after! }
      return snapshot.pullRequest ? buildGitHubFilePatch({ ...input, nativePatch }, mask) : buildDiffFilePatch(input, mask)
    },
  }
}
