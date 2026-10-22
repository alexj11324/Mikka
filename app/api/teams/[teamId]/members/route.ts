import { getTranslations } from 'next-intl/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/session'
import { listTeamMembers } from '@/app/actions/teams'
import { WorkspaceError } from '@/lib/workspace-access'

export async function GET(_request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const i18nText = await getTranslations();
  const headers = { 'Cache-Control': 'private, no-store' }
  if (!(await getSession())?.user) return NextResponse.json({ error: i18nText("Errors.authRequired") }, { status: 401, headers })
  const { teamId } = await params
  if (!z.uuid().safeParse(teamId).success) return NextResponse.json({ error: i18nText("FeatureCopy.c_424dce2c") }, { status: 400, headers })
  try {
    return NextResponse.json(await listTeamMembers(teamId), { headers })
  } catch (error) {
    return NextResponse.json({ error: error instanceof WorkspaceError ? (i18nText.has(`Errors.${error.code}` as never) ? i18nText(`Errors.${error.code}` as never) : error.message) : i18nText("FeatureCopy.c_411f8090") }, { status: error instanceof WorkspaceError ? 403 : 500, headers })
  }
}
