import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { GitHubPermissionsError, githubPermissionsPatchSchema, readGitHubPermissions, setGitHubPermissions } from '@/lib/github/plugin-permissions'
import { noteLogUser, withRequestLog } from '@/lib/request-log'

const headers = { 'Cache-Control': 'private, no-store' }
const fail = (error: string, status: number, viewerId?: string) => Response.json({ ...(viewerId ? { viewerId } : {}), error }, { status, headers })

/** A browser session only: a token cannot read or change what Agents may do. */
async function viewer(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  noteLogUser(session?.user?.id)
  return session?.user?.id ?? null
}

function failure(error: unknown, viewerId: string) {
  if (error instanceof GitHubPermissionsError) return fail(error.code, 409, viewerId)
  throw error
}

/** 推送分支 and 创建 Pull Request for the signed-in person's own Coordinator. */
async function handleGET(request: Request) {
  const viewerId = await viewer(request)
  if (!viewerId) return fail('authRequired', 401)
  try { return Response.json({ viewerId, ...await readGitHubPermissions(pool, viewerId) }, { headers }) }
  catch (error) { return failure(error, viewerId) }
}

async function handlePATCH(request: Request) {
  const viewerId = await viewer(request)
  if (!viewerId) return fail('authRequired', 401)
  if (request.headers.get('origin') !== new URL(request.url).origin) return fail('originNotAllowed', 403, viewerId)
  const input = githubPermissionsPatchSchema.safeParse(await request.json().catch(() => null))
  if (!input.success) return fail('invalidRequest', 400, viewerId)
  try { return Response.json({ viewerId, ...await setGitHubPermissions(pool, viewerId, input.data) }, { headers }) }
  catch (error) { return failure(error, viewerId) }
}

export const GET = withRequestLog('/api/integrations/github/permissions', handleGET)
export const PATCH = withRequestLog('/api/integrations/github/permissions', handlePATCH)
