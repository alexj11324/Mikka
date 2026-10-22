import { getTranslations } from 'next-intl/server'
import { and, eq } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { withBasePath } from '@/lib/base-path'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers, workspaces } from '@/lib/db/workspace-schema'

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const i18nText = await getTranslations();
  const { slug } = await params
  if (!/^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])$/.test(slug)) return new NextResponse(i18nText("FeatureCopy.c_5893c8c0"), { status: 404 })
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.redirect(new URL(withBasePath(`/sign-in?next=${encodeURIComponent(`/w/${slug}`)}`), request.url))
  const [workspace] = await workspaceDb.select({ id: workspaces.id }).from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaces.slug, slug), eq(workspaceMembers.userId, session.user.id), eq(workspaceMembers.status, 'active'))).limit(1)
  if (!workspace) return new NextResponse(i18nText("FeatureCopy.c_5893c8c0"), { status: 404, headers: { 'Cache-Control': 'private, no-store' } })
  const response = NextResponse.redirect(new URL(withBasePath('/'), request.url))
  response.headers.set('Cache-Control', 'private, no-store')
  for (const name of ['mikka-workspace', 'orvilo-workspace']) response.cookies.set(name, workspace.id, { httpOnly: true, sameSite: process.env.NODE_ENV === 'development' ? 'none' : 'lax', secure: true, path: '/', maxAge: 31536000 })
  return response
}
