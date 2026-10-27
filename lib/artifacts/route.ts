import 'server-only'
import { auth } from '@/lib/auth'
import { readArtifactContent } from '@/lib/artifacts/store'

/** The signed-in person's artifact file for a route's `[artifactId]/versions/[version]`, or a response to send instead. */
export async function routeArtifact(request: Request, params: Promise<{ artifactId: string; version: string }>) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return new Response('Sign in to view this.', { status: 401 })
  const { artifactId, version } = await params
  const number = Number(version)
  if (!/^[0-9a-f-]{36}$/i.test(artifactId) || !Number.isInteger(number) || number < 1) return new Response('Not found', { status: 404 })
  const found = await readArtifactContent(session.user.id, artifactId, number)
  return found ? { ...found, version: number } : new Response('Not found', { status: 404 })
}
