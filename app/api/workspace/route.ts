import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'
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
    if (error instanceof WorkspaceError) {
      const t = await getTranslations('Errors')
      return NextResponse.json({ error: t.has(error.code as never) ? t(error.code as never) : error.message }, { status: 403 })
    }
    console.error('Workspace settings could not be loaded', error instanceof Error ? error.name : 'UnknownError')
    return NextResponse.json({ error: 'workspaceReadFailed' }, { status: 500 })
  }
}
