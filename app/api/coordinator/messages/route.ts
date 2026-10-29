import { noteLogUser, withRequestLog } from '@/lib/request-log'
import { after, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { personalSubmissionInput, recordPersonalSubmission, SubmissionConflictError, readPersonalSubmissionBody, PersonalSubmissionBodyError } from '@/lib/coordinator-submission'
import { chatView } from '@/lib/coordinator/store'
import { coordinatorEnabled, wakeCoordinator } from '@/lib/coordinator/wake'

export const dynamic = 'force-dynamic'

/** `GET /api/coordinator/messages`: the person's conversation with their Coordinator, oldest first. */
async function handleGET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  noteLogUser(session?.user?.id)
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  return NextResponse.json({ enabled: coordinatorEnabled(), ...(await chatView(session.user.id)) }, { headers: { 'Cache-Control': 'private, no-store' } })
}

/**
 * `POST /api/coordinator/messages` with `{ text?, images?: [{dataUrl}], submissionId? }`: a message to the
 * Coordinator. It lands in the inbox and wakes a turn; the reply shows up in
 * the conversation.
 */
async function handlePOST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  noteLogUser(session?.user?.id)
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  let body:unknown
  try{body=await readPersonalSubmissionBody(request)}catch(error){if(error instanceof PersonalSubmissionBodyError)return NextResponse.json({error:'messageRequired'},{status:error.status});throw error}
  const parsed = personalSubmissionInput.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'messageRequired' }, { status: 400 })
  const userId = session.user.id
  try { await recordPersonalSubmission(db, userId, parsed.data.text, { submissionId: parsed.data.submissionId, images:parsed.data.images, ...(!request.headers.has('authorization')&&request.headers.get('cookie')&&request.headers.get('origin')===new URL(request.url).origin?{humanSessionId:session.session.id}:{}) }) }
  catch (error) {
    if (error instanceof SubmissionConflictError) return NextResponse.json({ error: 'submissionConflict' }, { status: 409 })
    throw error
  }
  after(() => wakeCoordinator(userId))
  return NextResponse.json({ queued: true, enabled: coordinatorEnabled() }, { status: 202 })
}

export const GET = withRequestLog('/api/coordinator/messages', handleGET)
export const POST = withRequestLog('/api/coordinator/messages', handlePOST)
