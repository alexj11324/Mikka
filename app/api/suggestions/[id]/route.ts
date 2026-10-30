import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getApiSession } from '@/lib/api-auth'
import { dismissSuggestion } from '@/lib/suggestions/store'

export const runtime = 'nodejs'

/** Takes one suggestion off the person's list. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const headers = { 'Cache-Control': 'no-store' }
  const user = (await getApiSession({ headers: request.headers }))?.user
  if (!user) return NextResponse.json({ error: 'authRequired' }, { status: 401, headers })
  if (request.headers.get('origin') !== new URL(request.url).origin) return NextResponse.json({ error: 'originNotAllowed' }, { status: 403, headers })
  const { id } = await params
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: 'invalidSuggestion' }, { status: 400, headers })
  return await dismissSuggestion(user.id, id) ? new Response(null, { status: 204, headers }) : NextResponse.json({ error: 'suggestionNotFound' }, { status: 404, headers })
}
