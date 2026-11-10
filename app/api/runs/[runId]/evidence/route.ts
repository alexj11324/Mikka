import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticatedArtifactReader } from '@/lib/artifacts/route'
import { runEvidence } from '@/lib/captures/store'
import { withBasePath } from '@/lib/base-path'
import { runOutsideToken } from '@/lib/tokens/scope'

export const dynamic = 'force-dynamic'

/**
 * `GET /api/runs/:runId/evidence`: what one of the person's threads
 * produced, for acceptance: its screenshots and recordings and the
 * documents it handed over. Only the run's owner reads it (R-62).
 */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const reader = await authenticatedArtifactReader(request.headers)
  const headers = { 'cache-control': 'private, no-store' }
  if (!reader) return NextResponse.json({ error: 'Sign in required' }, { status: 401, headers })
  const { runId } = await params
  const found = z.uuid().safeParse(runId).success && !await runOutsideToken(reader, runId) ? await runEvidence(reader, runId) : null
  if (!found) return NextResponse.json({ error: 'Not found' }, { status: 404, headers })
  // This opt-in view is for a real candidate's one-use bootstrap. Ordinary
  // evidence retains its original query and response, without loading this path.
  let bootstrap: unknown
  const query = new URL(request.url).searchParams
  if (query.has('bootstrap')) {
    const { bootstrapEvidenceQuery, readRunBootstrapEvidence } = await import('@/lib/captures/bootstrap-evidence')
    const parsed = bootstrapEvidenceQuery.safeParse(Object.fromEntries(query))
    if (!parsed.success || [...query.keys()].length !== Object.keys(parsed.data).length)
      return NextResponse.json({ error: 'Invalid bootstrap evidence request' }, { status: 400, headers })
    const { pool } = await import('@/lib/db')
    bootstrap = await readRunBootstrapEvidence(pool, reader.id, runId, parsed.data)
    if (!bootstrap) return NextResponse.json({ error: 'Not found' }, { status: 404, headers })
  }
  return NextResponse.json({
    ...found,
    ...(bootstrap ? { bootstrap } : {}),
    captures: found.captures.map(capture => ({ ...capture, url: withBasePath(`/api/captures/${capture.id}`) })),
    artifacts: found.artifacts.map(artifact => ({ ...artifact, url: withBasePath(`/api/artifacts/${artifact.id}/versions/${artifact.latestVersion}/download`) })),
  }, { headers })
}
