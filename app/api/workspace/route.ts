import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { loadWorkspaceSettings, WorkspaceError } from '@/lib/workspace-access'

export async function GET(request: Request) {
  const started = performance.now()
  const session = await auth.api.getSession({ headers: request.headers })
  const authenticated = performance.now()
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  try {
    const data = await loadWorkspaceSettings(new URL(request.url).searchParams.get('workspace') ?? undefined, session.user)
    return NextResponse.json(data, { headers: {
      'Cache-Control': 'private, no-store',
      'Server-Timing': `auth;dur=${(authenticated - started).toFixed(1)}, workspace;dur=${(performance.now() - authenticated).toFixed(1)}`,
    } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof WorkspaceError ? error.code : 'workspaceReadFailed' }, { status: 403 })
  }
}
