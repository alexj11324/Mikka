import 'server-only'
import { auth } from '@/lib/api-auth'
import { readArtifactContent } from '@/lib/artifacts/store'
import { artifactOutsideToken } from '@/lib/tokens/scope'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal } from '@/lib/enterprise/principal'

/** The signed-in person's artifact file for a route's `[artifactId]/versions/[version]`, or a response to send instead. */
export async function routeArtifact(request: Request, params: Promise<{ artifactId: string; version: string }>) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return new Response('Sign in to view this.', { status: 401 })
  const { artifactId, version } = await params
  const number = Number(version)
  if (!/^[0-9a-f-]{36}$/i.test(artifactId) || !Number.isInteger(number) || number < 1) return new Response('Not found', { status: 404 })
  if (await artifactOutsideToken(session.user, artifactId)) return new Response('Not found', { status: 404 })
  const context = await loadWorkspaceContext(undefined, session.user)
  const found = await readArtifactContent({ id: session.user.id, [tokenWorkspace]: context.workspace.id, [enterprisePrincipal]: session.user[enterprisePrincipal] }, artifactId, number)
  return found ? { ...found, version: number } : new Response('Not found', { status: 404 })
}
