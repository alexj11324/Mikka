import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth, apiWorkspaceAllowed } from '@/lib/api-auth'
import { AUDIT_FILTERS, csvField } from '@/lib/audit/cursor'
import { exportWorkspaceAudit } from '@/lib/audit/query'
import { WorkspaceError } from '@/lib/workspace-access'

export const runtime = 'nodejs'
export const maxDuration = 60

type Context = { params: Promise<{ workspaceId: string }> }

/** 审计日志 › 导出 CSV: the last 90 days (or only 安全), admins only. */
export async function GET(request: Request, { params }: Context) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return new NextResponse(null, { status: 401 })
  const { workspaceId } = await params
  if (!apiWorkspaceAllowed(session, workspaceId)) return new NextResponse(null, { status: 403 })
  if (!z.uuid().safeParse(workspaceId).success) return new NextResponse(null, { status: 404 })
  const filter = new URL(request.url).searchParams.get('filter') ?? 'all'
  if (!(AUDIT_FILTERS as readonly string[]).includes(filter)) return new NextResponse(null, { status: 400 })
  try {
    const events = await exportWorkspaceAudit(session.user.id, workspaceId, filter)
    const header = ['time', 'actor', 'actor_type', 'action', 'category', 'target', 'ip', 'city']
    const lines = events.map(event => [event.createdAt, event.actorName, event.actorType, event.action, event.category, event.targetLabel, event.ip, event.geoCity].map(csvField).join(','))
    return new NextResponse(`﻿${[header.join(','), ...lines].join('\r\n')}\r\n`, { headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'private, no-store',
    } })
  } catch (error) {
    if (error instanceof WorkspaceError) return new NextResponse(null, { status: 404 })
    throw error
  }
}
