import { withRequestLog } from '@/lib/request-log'
import { getTranslations } from 'next-intl/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/session'
import { loadTeamDirectory } from '@/app/actions/teams'
import { WorkspaceError } from '@/lib/workspace-access'

async function handleGET(request: Request) {
  const i18nText = await getTranslations();
  if (!(await getSession())?.user) return NextResponse.json({ error: i18nText("Errors.authRequired") }, { status: 401 })
  const workspaceId = new URL(request.url).searchParams.get('workspace') ?? undefined
  if (workspaceId && !z.uuid().safeParse(workspaceId).success) return NextResponse.json({ error: i18nText("FeatureCopy.c_b87b9c8f") }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    const directory = await loadTeamDirectory(workspaceId)
    return NextResponse.json(directory, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof WorkspaceError ? (i18nText.has(`Errors.${error.code}` as never) ? i18nText(`Errors.${error.code}` as never) : error.message) : i18nText("FeatureCopy.c_d7d814ec") }, { status: error instanceof WorkspaceError ? 403 : 500, headers: { 'Cache-Control': 'private, no-store' } })
  }
}

export const GET = withRequestLog('/api/teams/directory', handleGET)
