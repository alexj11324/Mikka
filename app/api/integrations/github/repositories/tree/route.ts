import { workspacePath } from '@mikka/protocol/coding-workspace'
import { auth } from '@/lib/auth'
import { humanSessionHeaders } from '@/lib/desktop-rpc/handler'
import { repositorySchema } from '@/lib/github/repository-input'
import { GitHubAccessError, readRepositoryTree } from '@/lib/github/user-access'
import { withRequestLog } from '@/lib/request-log'

const headers = { 'Cache-Control': 'private, no-store' }

export const GET = withRequestLog('/api/integrations/github/repositories/tree', async (request: Request) => {
  const sessionHeaders = humanSessionHeaders(request)
  const session = sessionHeaders && await auth.api.getSession({ headers: sessionHeaders, query: { disableCookieCache: true } })
  if (!session?.user) return Response.json({ error: 'authRequired' }, { status: 401, headers })
  const params = new URL(request.url).searchParams
  const name = repositorySchema.safeParse(params.get('repository'))
  const ref = params.get('ref') ?? 'HEAD'
  if (!name.success || !ref || !workspacePath.safeParse(ref).success || ref.includes(' ')) return Response.json({ error: 'invalidInput' }, { status: 400, headers })
  try {
    const result = await readRepositoryTree(session.user.id, name.data, ref, { deadline: Date.now() + 25_000, signal: request.signal })
    return Response.json(result, { headers })
  } catch (error) {
    if (request.signal.aborted) throw error
    const failure = error instanceof GitHubAccessError ? error : new GitHubAccessError('githubUnavailable', 502)
    return Response.json({ error: failure.code }, { status: failure.status, headers })
  }
})
