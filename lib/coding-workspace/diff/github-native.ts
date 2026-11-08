import 'server-only'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { CodingWorkspaceError, visibleWorkspacePath, workspacePath } from '@mikka/protocol/coding-workspace'
import { githubReviewPage, githubReviewQuery, WorkspaceReviewError, type DiffSnapshot, type GitHubReviewPage,
  type GitHubReviewQuery, type GitHubReviewThread } from '@mikka/protocol/coding-workspace-review'
import { githubRepositoryReadCredential, GitHubAccessError } from '../../github/user-access'
import { githubRepository } from '../../github/run-pull-request'
import { CloudServiceError } from '../../cloud-services/errors'
import { secretMaskerFor } from '../../secrets/runtime'
import type { Masker } from '../../secrets/mask'
import type { RequestBudget } from '../../request-budget'
import { resolveReviewScope, type ReviewActor } from './authority'
import { associatedGitHubPull } from './github'
import { GitHubDiffClient } from './github-api'
import type { DiffDependencies } from './service'
import { readDiffSnapshot } from './store'

const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
const id = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String), z.string().regex(/^[1-9]\d{0,39}$/)])
const nodeId = z.string().regex(/^[A-Za-z0-9_=-]{1,200}$/)
const line = z.number().int().min(1).max(1_000_000).nullable()
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().min(1).max(1024).nullable() })
const pull = z.object({ number: z.number().int().positive(), headRefOid: sha, baseRefOid: sha,
  repository: z.object({ databaseId: id, nameWithOwner: z.string() }) })
const comment = z.object({ id: nodeId, fullDatabaseId: id, replyTo: z.object({ fullDatabaseId: id }).nullable(),
  body: z.string().max(1024 * 1024), author: z.object({ login: z.string().max(100) }).nullable(),
  commit: z.object({ oid: sha }).nullable(), originalCommit: z.object({ oid: sha }).nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() })
const thread = z.object({ id: nodeId, path: workspacePath.refine(Boolean), diffSide: z.enum(['LEFT', 'RIGHT']),
  startDiffSide: z.enum(['LEFT', 'RIGHT']).nullable(), line, startLine: line, originalLine: line, originalStartLine: line,
  subjectType: z.enum(['LINE', 'FILE']), isResolved: z.boolean(), isOutdated: z.boolean(),
  comments: z.object({ nodes: z.array(comment).max(20), pageInfo }) })
const cursorSchema = z.strictObject({ version: z.literal(1), snapshotId: z.uuid(), sourceVersion: z.string().regex(/^[a-f0-9]{64}$/),
  repositoryId: id, number: z.number().int().positive(), headSha: sha, baseSha: sha,
  threadId: nodeId.nullable(), after: z.string().min(1).max(1024) })
type Cursor = z.infer<typeof cursorSchema>
const unavailable = () => new WorkspaceReviewError('workspace_review_github_unavailable')
const outdated = () => new WorkspaceReviewError('workspace_snapshot_outdated')
const nativeMaskPolicy = Symbol('nativeReviewFullBodyPolicy')
/** Complete native bodies are transient. Final HTTP serialization must use
 * exactly the policies that saw them, not re-mask an already truncated prefix. */
export function nativeReviewPolicyMatches(value: unknown, masks: Masker[]): boolean {
  if (!value || typeof value !== 'object') return false
  const proof = (value as { [nativeMaskPolicy]?: string[] })[nativeMaskPolicy]
  return Boolean(proof && proof.length === masks.length && masks.every((mask, index) => mask.sourcePolicy && mask.sourcePolicy === proof[index]))
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw unavailable()
  return result.data
}

const pullFields = 'number headRefOid baseRefOid repository { databaseId nameWithOwner }'
const commentFields = 'id fullDatabaseId replyTo { fullDatabaseId } body author { login } commit { oid } originalCommit { oid } createdAt updatedAt'
const threadFields = 'id path diffSide startDiffSide line startLine originalLine originalStartLine subjectType isResolved isOutdated'
const threadsDocument = `query WorkspaceReviewThreads($owner:String!,$name:String!,$number:Int!,$after:String) {
  repository(owner:$owner,name:$name) { pullRequest(number:$number) { ${pullFields}
    reviewThreads(first:20,after:$after) { pageInfo { hasNextPage endCursor } nodes { ${threadFields}
      comments(first:20) { pageInfo { hasNextPage endCursor } nodes { ${commentFields} } }
    } }
  } }
}`
const commentsDocument = `query WorkspaceReviewComments($id:ID!,$after:String) {
  node(id:$id) { __typename ... on PullRequestReviewThread { ${threadFields} pullRequest { ${pullFields} }
    comments(first:20,after:$after) { pageInfo { hasNextPage endCursor } nodes { ${commentFields} } }
  } }
}`

export type GitHubReviewReadGrant = { client: GitHubDiffClient; owner: string; repo: string; repositoryId: string; number: number }

/** Provider-native thread coordinates are preserved as historical metadata.
 * They are not converted into validated Mikka anchors without blob evidence. */
export async function readNativeGitHubReview(grant: GitHubReviewReadGrant, snapshot: DiffSnapshot, query: GitHubReviewQuery,
  mask: (body: string) => string): Promise<GitHubReviewPage> {
  query = githubReviewQuery.parse(query)
  if (snapshot.sourceAccess?.repositoryId !== grant.repositoryId || snapshot.sourceAccess.pullRequestNumber !== grant.number
    || snapshot.pullRequest?.number !== grant.number) throw new WorkspaceReviewError('workspace_review_github_forbidden')
  let after: Cursor | undefined
  if (query.cursor) {
    try { after = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))) }
    // error-cause: a malformed client cursor may contain private arbitrary input.
    catch { throw new CodingWorkspaceError('workspace_invalid_request') }
    if (after.snapshotId !== snapshot.id || after.sourceVersion !== snapshot.revision.version || after.repositoryId !== grant.repositoryId || after.number !== grant.number
      || after.threadId !== (query.threadId ?? null)) throw outdated()
  }
  let current: z.infer<typeof pull>, entries: z.infer<typeof thread>[], outer: z.infer<typeof pageInfo> | undefined
  if (query.threadId) {
    const value = parse(z.object({ node: thread.extend({ __typename: z.literal('PullRequestReviewThread'), pullRequest: pull }) }),
      await grant.client.graphql(commentsDocument, { id: query.threadId, after: after?.after ?? null }))
    if (value.node.id !== query.threadId) throw unavailable()
    current = value.node.pullRequest; entries = [value.node]
  } else {
    const value = parse(z.object({ repository: z.object({ pullRequest: pull.extend({ reviewThreads:
      z.object({ nodes: z.array(thread).max(20), pageInfo }) }) }) }),
    await grant.client.graphql(threadsDocument, { owner: grant.owner, name: grant.repo, number: grant.number, after: after?.after ?? null }))
    current = value.repository.pullRequest; entries = value.repository.pullRequest.reviewThreads.nodes
    outer = value.repository.pullRequest.reviewThreads.pageInfo
  }
  if (current.number !== grant.number || current.repository.databaseId !== grant.repositoryId
    || current.repository.nameWithOwner.toLowerCase() !== `${grant.owner}/${grant.repo}`.toLowerCase())
    throw new WorkspaceReviewError('workspace_review_github_forbidden')
  if (after && (after.headSha !== current.headRefOid || after.baseSha !== current.baseRefOid)) throw outdated()
  const cursor = (page: z.infer<typeof pageInfo>, selectedThread: string | null, count: number) => {
    if (!page.hasNextPage) return null
    if (!page.endCursor || count === 0 || (selectedThread === (query.threadId ?? null) && page.endCursor === after?.after)) throw unavailable()
    return Buffer.from(JSON.stringify({ version: 1, snapshotId: snapshot.id, sourceVersion: snapshot.revision.version, repositoryId: grant.repositoryId,
      number: grant.number, headSha: current.headRefOid, baseSha: current.baseRefOid,
      threadId: selectedThread, after: page.endCursor } satisfies Cursor)).toString('base64url')
  }
  const seenThreads = new Set<string>(), seenComments = new Set<string>(), seenNodes = new Set<string>()
  const threads: GitHubReviewThread[] = entries.map(value => {
    if (seenThreads.has(value.id)) throw unavailable()
    seenThreads.add(value.id)
    if (!visibleWorkspacePath(value.path) || mask(value.path) !== value.path) throw new CodingWorkspaceError('workspace_path_unavailable')
    const comments = value.comments.nodes.map(item => {
      if (seenComments.has(item.fullDatabaseId) || seenNodes.has(item.id)) throw unavailable()
      seenComments.add(item.fullDatabaseId); seenNodes.add(item.id)
      // Mask the complete body before truncation, including secrets spanning
      // the response cap or multiple lines; never retain the unmasked body.
      const body = mask(item.body), displayed = body.slice(0, 4000)
      return { id: item.fullDatabaseId, nodeId: item.id, replyToId: item.replyTo?.fullDatabaseId ?? null,
        body: displayed, bodyTruncated: displayed.length !== body.length, author: item.author?.login ?? null,
        commitSha: item.commit?.oid ?? null, originalCommitSha: item.originalCommit?.oid ?? null,
        url: `https://github.com/${grant.owner}/${grant.repo}/pull/${grant.number}#discussion_r${item.fullDatabaseId}`,
        createdAt: item.createdAt, updatedAt: item.updatedAt }
    })
    return { id: value.id, path: value.path, side: value.diffSide, startSide: value.startDiffSide,
      line: value.line, startLine: value.startLine, originalLine: value.originalLine, originalStartLine: value.originalStartLine,
      subjectType: value.subjectType, resolved: value.isResolved, outdated: value.isOutdated, comments,
      nextCursor: cursor(value.comments.pageInfo, value.id, comments.length) }
  })
  return githubReviewPage.parse({ snapshotId: snapshot.id, sourceVersion: snapshot.revision.version, repositoryId: grant.repositoryId,
    pullRequestNumber: grant.number, observedAt: new Date().toISOString(), headSha: current.headRefOid, baseSha: current.baseRefOid,
    isStale: current.headRefOid !== snapshot.revision.headSha || current.baseRefOid !== snapshot.pullRequest.baseSha,
    threads, nextCursor: outer ? cursor(outer, null, entries.length) : null })
}

function accessError(error: unknown): never {
  if (error instanceof GitHubAccessError) throw new WorkspaceReviewError(['githubUnavailable', 'githubNotConfigured'].includes(error.code)
    ? 'workspace_review_github_unavailable' : 'workspace_review_github_forbidden')
  if (error instanceof CloudServiceError) throw new WorkspaceReviewError(error.code === 'cloud_unavailable'
    ? 'workspace_review_github_unavailable' : 'workspace_review_github_forbidden')
  if (error instanceof CodingWorkspaceError || error instanceof WorkspaceReviewError) throw error
  throw unavailable()
}

export async function readGitHubReview(deps: DiffDependencies, actor: ReviewActor, runId: string, repoId: string,
  snapshotId: string, raw: unknown, signal?: AbortSignal): Promise<GitHubReviewPage> {
  const query = githubReviewQuery.parse(raw)
  const scope = await resolveReviewScope(deps.database, deps.membership, actor, runId, repoId)
  const snapshot = await readDiffSnapshot(deps.database, scope, snapshotId)
  if (!snapshot.pullRequest || !snapshot.sourceAccess) throw new WorkspaceReviewError('workspace_snapshot_unavailable')
  const associated = await associatedGitHubPull(deps.database, scope)
  if (associated.number !== snapshot.pullRequest.number || !isDeepStrictEqual(associated.factory, snapshot.factory)) throw outdated()
  const budget: RequestBudget = { deadline: Date.now() + 30_000, signal }
  try {
    const credential = await githubRepositoryReadCredential(actor.userId, scope.identity.repositoryKey, budget)
    if (credential.repository.id !== snapshot.sourceAccess.repositoryId) throw new WorkspaceReviewError('workspace_review_github_forbidden')
    const masks: Masker[] = await Promise.all([
      secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: scope.identity.ownerId }),
      secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: actor.userId }),
    ])
    const repo = githubRepository(scope.identity.repositoryKey)
    const result = await readNativeGitHubReview({ client: new GitHubDiffClient(credential.token, budget), owner: repo.owner,
      repo: repo.repo, repositoryId: credential.repository.id, number: associated.number }, snapshot, query,
    body => masks.reduce((text, mask) => mask(text), body))
    if (!isDeepStrictEqual(await associatedGitHubPull(deps.database, scope), associated)) throw outdated()
    if (masks.some(mask => !mask.sourcePolicy)) throw new CodingWorkspaceError('workspace_path_unavailable')
    Object.defineProperty(result, nativeMaskPolicy, { value: masks.map(mask => mask.sourcePolicy!) })
    return result
  } catch (error) { return accessError(error) }
}
