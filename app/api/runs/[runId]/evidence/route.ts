import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { runEvidence } from '@/lib/captures/store'
import { withBasePath } from '@/lib/base-path'

export const dynamic = 'force-dynamic'

/**
 * `GET /api/runs/:runId/evidence`: what one of the person's threads
 * produced, for acceptance: its screenshots and recordings and the
 * documents it handed over. Only the run's owner reads it (R-62).
 */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers })
  const headers = { 'cache-control': 'private, no-store' }
  if (!session?.user) return NextResponse.json({ error: 'Sign in required' }, { status: 401, headers })
  const { runId } = await params
  const found = z.uuid().safeParse(runId).success ? await runEvidence(session.user.id, runId) : null
  if (!found) return NextResponse.json({ error: 'Not found' }, { status: 404, headers })
  return NextResponse.json({
    ...found,
    captures: found.captures.map(capture => ({ ...capture, url: withBasePath(`/api/captures/${capture.id}`) })),
    artifacts: found.artifacts.map(artifact => ({ ...artifact, url: withBasePath(`/api/artifacts/${artifact.id}/versions/${artifact.latestVersion}/download`) })),
  }, { headers })
}
