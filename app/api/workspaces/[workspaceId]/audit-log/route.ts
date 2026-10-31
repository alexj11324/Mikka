import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth, apiWorkspaceAllowed } from '@/lib/api-auth'
import { AUDIT_FILTERS, csvField } from '@/lib/audit/cursor'
import { createHash } from 'node:crypto'
import { AuditExportError, createAuditExport, readAuditExportPage } from '@/lib/audit/export'
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
  const search = new URL(request.url).searchParams
  const filter = search.get('filter') ?? 'all'
  if (!(AUDIT_FILTERS as readonly string[]).includes(filter)) return new NextResponse(null, { status: 400 })
  const format = search.get('format') ?? 'csv'
  const page = z.object({ exportId: z.uuid().nullable(), offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(1000).default(100) }).safeParse({
    exportId: search.get('exportId'), offset: search.get('offset') ?? undefined, limit: search.get('limit') ?? undefined,
  })
  if (!page.success || !['csv', 'json'].includes(format) || (format === 'csv' && page.data.exportId) || (!page.data.exportId && page.data.offset !== 0)) return new NextResponse(null, { status: 400 })
  try {
    const result = page.data.exportId
      ? await readAuditExportPage(session.user.id, workspaceId, page.data.exportId, page.data.offset, page.data.limit)
      : await createAuditExport(session.user.id, workspaceId, filter as 'all' | 'security')
    if (format === 'json') {
      const events = page.data.exportId ? result.events : result.events.slice(0, page.data.limit)
      const nextOffset = page.data.exportId && 'nextOffset' in result ? result.nextOffset : events.length < result.manifest.count ? events.length : null
      return NextResponse.json({ manifest: result.manifest, events, nextOffset }, { headers: { 'cache-control': 'private, no-store' } })
    }
    const events = result.events
    const header = ['time', 'actor', 'actor_type', 'action', 'category', 'target', 'ip', 'city']
    const lines = events.map(event => [event.createdAt, event.actorName, event.actorType, event.action, event.category, event.targetLabel, event.ip, event.geoCity].map(csvField).join(','))
    const content = `﻿${[header.join(','), ...lines].join('\r\n')}\r\n`
    return new NextResponse(content, { headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'private, no-store',
      'x-mikka-audit-export-id': result.manifest.id,
      'x-mikka-audit-count': String(result.manifest.count),
      'x-mikka-audit-content-sha256': createHash('sha256').update(content).digest('hex'),
      'x-mikka-audit-digest': result.manifest.digest,
    } })
  } catch (error) {
    if (error instanceof AuditExportError) return NextResponse.json({ error: error.code }, { status: error.status, headers: { 'cache-control': 'private, no-store' } })
    if (error instanceof WorkspaceError) return new NextResponse(null, { status: 404 })
    throw error
  }
}
