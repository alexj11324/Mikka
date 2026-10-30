import { withRequestLog } from '@/lib/request-log'
import { getTranslations } from 'next-intl/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getApiSession } from '@/lib/api-auth'
import { actAs } from '@/lib/acting-user'
import { listTeamMembers } from '@/app/actions/teams'
import { WorkspaceError } from '@/lib/workspace-access'

async function handleGET(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const i18nText = await getTranslations();
  const headers = { 'Cache-Control': 'private, no-store' }
  const session = await getApiSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: i18nText("Errors.authRequired") }, { status: 401, headers })
  const { teamId } = await params
  if (!z.uuid().safeParse(teamId).success) return NextResponse.json({ error: i18nText("FeatureCopy.c_424dce2c") }, { status: 400, headers })
  try {
    return NextResponse.json(await actAs(session.user.id, () => listTeamMembers(teamId, session.tokenWorkspaceId)), { headers })
  } catch (error) {
    return NextResponse.json({ error: error instanceof WorkspaceError ? (i18nText.has(`Errors.${error.code}` as never) ? i18nText(`Errors.${error.code}` as never) : error.message) : i18nText("FeatureCopy.c_411f8090") }, { status: error instanceof WorkspaceError ? 403 : 500, headers })
  }
}

export const GET = withRequestLog('/api/teams/[teamId]/members', handleGET)
