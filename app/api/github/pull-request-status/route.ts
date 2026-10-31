import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { issueForUser } from '@/lib/issue-access'
import { pullRequestSchema, readIssueMetadata } from '@/lib/issue-metadata'
import { GitHubAccessError, readAuthorizedPullRequest } from '@/lib/github/user-access'
import { noteLogUser, withRequestLog } from '@/lib/request-log'

const inputSchema = z.object({ issueId: z.uuid(), url: pullRequestSchema.shape.url }).strict()
const canonicalUrl = (url: string) => url.replace(/\/$/, '').toLowerCase()
const headers = { 'Cache-Control': 'private, no-store' }
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers })

async function handlePOST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  noteLogUser(session?.user?.id)
  if (!session?.user) return fail('authRequired', 401)
  if (request.headers.get('origin') !== new URL(request.url).origin) return fail('originNotAllowed', 403)
  const input = inputSchema.safeParse(await request.json().catch(() => null))
  if (!input.success) return fail('githubPullRequestInvalid', 400)
  const issue = await issueForUser(session.user.id, input.data.issueId)
  if (!issue) return fail('issueNotFound', 404)
  const linked = readIssueMetadata(issue.content).pullRequests.find(pr => canonicalUrl(pr.url) === canonicalUrl(input.data.url))
  if (!linked) return fail('githubPullRequestNotLinked', 404)
  try {
    const pr = await readAuthorizedPullRequest(request.headers, linked.url)
    if (pr.userId !== session.user.id) return fail('authRequired', 401)
    // GitHub data is returned only to this viewer, never persisted in shared metadata.
    return NextResponse.json({ viewerId: session.user.id, url: pr.url, state: pr.state, updatedAt: pr.updatedAt }, { headers })
  } catch (error) {
    return error instanceof GitHubAccessError ? fail(error.code, error.status) : fail('githubUnavailable', 502)
  }
}

export const POST = withRequestLog('/api/github/pull-request-status', handlePOST)
