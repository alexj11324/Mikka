import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/session'
import { listTeamMembers } from '@/app/actions/teams'
import { WorkspaceError } from '@/lib/workspace-access'

export async function GET(_request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const headers = { 'Cache-Control': 'private, no-store' }
  if (!(await getSession())?.user) return NextResponse.json({ error: '请先登录。' }, { status: 401, headers })
  const { teamId } = await params
  if (!z.uuid().safeParse(teamId).success) return NextResponse.json({ error: '团队标识无效。' }, { status: 400, headers })
  try {
    return NextResponse.json(await listTeamMembers(teamId), { headers })
  } catch (error) {
    return NextResponse.json({ error: error instanceof WorkspaceError ? error.message : '无法读取团队成员，请稍后重试。' }, { status: error instanceof WorkspaceError ? 403 : 500, headers })
  }
}
