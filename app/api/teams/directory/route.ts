import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/session'
import { loadTeamDirectory } from '@/app/actions/teams'
import { WorkspaceError } from '@/lib/workspace-access'

export async function GET(request: Request) {
  if (!(await getSession())?.user) return NextResponse.json({ error: '请先登录。' }, { status: 401 })
  const workspaceId = new URL(request.url).searchParams.get('workspace') ?? undefined
  if (workspaceId && !z.uuid().safeParse(workspaceId).success) return NextResponse.json({ error: '工作区标识无效。' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    const directory = await loadTeamDirectory(workspaceId)
    return NextResponse.json(directory, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof WorkspaceError ? error.message : '团队读取失败，请稍后重试。' }, { status: error instanceof WorkspaceError ? 403 : 500, headers: { 'Cache-Control': 'private, no-store' } })
  }
}
