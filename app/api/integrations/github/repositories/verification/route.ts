import { z } from 'zod'
import { auth } from '@/lib/auth'
import { GitHubAccessError, listAuthorizedRepositories } from '@/lib/github/user-access'
import { readRepositorySettings, saveRepositoryVerifyCommand } from '@/lib/device-repositories'
import { withRequestLog } from '@/lib/request-log'

const headers = { 'Cache-Control': 'private, no-store' }
const repositorySchema = z.string().max(201).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .refine(value => value.split('/').every(part => part !== '.' && part !== '..' && !part.startsWith('-')))
const updateSchema = z.object({ repository: repositorySchema, verifyCommand: z.string().trim().max(2000).nullable() }).strict()

async function handle(request: Request) {
  if (!request.headers.get('cookie') || request.headers.has('authorization')) return Response.json({ error: 'authRequired' }, { status: 401, headers })
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return Response.json({ error: 'authRequired' }, { status: 401, headers })
  const viewerId = session.user.id
  if (request.method === 'PATCH' && request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ viewerId, error: 'originNotAllowed' }, { status: 403, headers })
  let repository: string
  let verifyCommand: string | null = null
  if (request.method === 'PATCH') {
    const parsed = updateSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return Response.json({ viewerId, error: 'invalidInput' }, { status: 400, headers })
    repository = parsed.data.repository
    verifyCommand = parsed.data.verifyCommand || null
  } else {
    const parsed = repositorySchema.safeParse(new URL(request.url).searchParams.get('repository'))
    if (!parsed.success) return Response.json({ viewerId, error: 'invalidInput' }, { status: 400, headers })
    repository = parsed.data
  }
  try {
    const access = await listAuthorizedRepositories(request.headers)
    if (access.userId !== viewerId) throw new GitHubAccessError('authRequired', 401)
    const authorized = access.repositories.find(row => row.fullName.toLowerCase() === repository.toLowerCase())
    if (!authorized) throw new GitHubAccessError('githubRepositoryForbidden', 403)
    const remoteUrl = `https://github.com/${authorized.fullName}.git`
    const settings = request.method === 'PATCH'
      ? await saveRepositoryVerifyCommand(viewerId, remoteUrl, verifyCommand)
      : await readRepositorySettings(viewerId, remoteUrl)
    return Response.json({ viewerId, repository: authorized.fullName, verifyCommand: settings?.verifyCommand ?? null }, { headers })
  } catch (error) {
    return Response.json({ viewerId, error: error instanceof GitHubAccessError ? error.code : 'githubUnavailable' }, { status: error instanceof GitHubAccessError ? error.status : 502, headers })
  }
}

export const GET = withRequestLog('/api/integrations/github/repositories/verification', handle)
export const PATCH = withRequestLog('/api/integrations/github/repositories/verification', handle)
