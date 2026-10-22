import { NextResponse } from 'next/server'
import { listIssues } from '@/app/actions/issues'
import { listProjects } from '@/app/actions/projects'
import { ActionFailureError } from '@/lib/action-error'

export async function GET(request: Request) {
  const kind = new URL(request.url).searchParams.get('kind')
  const headers = { 'Cache-Control': 'private, no-store' }
  if (kind !== 'issues' && kind !== 'projects') return NextResponse.json({ error: 'invalidList' }, { status: 400, headers })
  const started = performance.now()
  try {
    const data = kind === 'issues' ? await listIssues() : await listProjects()
    return NextResponse.json(data, { headers: {
      ...headers,
      'Server-Timing': `list;dur=${(performance.now() - started).toFixed(1)}`,
    } })
  } catch (error) {
    if (error instanceof ActionFailureError && error.code === 'authRequired') {
      return NextResponse.json({ error: error.code }, { status: 401, headers })
    }
    console.error('Workspace list could not be loaded', kind, error instanceof Error ? error.name : 'UnknownError')
    return NextResponse.json({ error: 'listReadFailed' }, { status: 500, headers })
  }
}
