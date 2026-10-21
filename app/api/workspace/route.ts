import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { loadWorkspaceSettings, WorkspaceError } from '@/lib/workspace-access'

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: '请先登录。' }, { status: 401 })
  try {
    const data = await loadWorkspaceSettings(new URL(request.url).searchParams.get('workspace') ?? undefined, session.user)
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof WorkspaceError ? error.message : '无法读取成员，请稍后重试。' }, { status: 403 })
  }
}
