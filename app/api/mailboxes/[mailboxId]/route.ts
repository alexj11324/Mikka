import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { mailboxes } from '@/lib/mailbox-runtime'
import { MailboxError } from '@/lib/session-mailbox'

// Owner-only policy. Peer/run credentials cannot reach this capability.
export async function PATCH(request: Request, { params }: { params: Promise<{ mailboxId: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const input = z.object({ wakeBudget: z.number().int().min(0).max(10), disabled: z.boolean() }).strict().safeParse(await request.json().catch(() => null))
  const { mailboxId } = await params
  if (!input.success || !z.uuid().safeParse(mailboxId).success) return NextResponse.json({ error: 'Invalid policy' }, { status: 400 })
  try { return NextResponse.json(await mailboxes.policy(session.user.id, mailboxId, input.data.wakeBudget, input.data.disabled)) }
  catch (error) { if (error instanceof MailboxError) return NextResponse.json({ error: error.message }, { status: error.status }); throw error }
}

/** A signed-in owner may explicitly answer a human gate and request one resume. */
export async function POST(request: Request, { params }: { params: Promise<{ mailboxId: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const input = z.object({ key: z.uuid(), text: z.string().trim().min(1).max(4000), resume: z.boolean().default(false) }).strict().safeParse(await request.json().catch(() => null))
  const { mailboxId } = await params
  if (!input.success || !z.uuid().safeParse(mailboxId).success) return NextResponse.json({ error: 'Invalid envelope' }, { status: 400 })
  try { return NextResponse.json(await mailboxes.ownerSend(session.user.id, { ...input.data, to: mailboxId })) }
  catch (error) { if (error instanceof MailboxError) return NextResponse.json({ error: error.message }, { status: error.status }); throw error }
}


export async function GET(_request: Request, { params }: { params: Promise<{ mailboxId: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { mailboxId } = await params
  if (!z.uuid().safeParse(mailboxId).success) return NextResponse.json({ error: 'Invalid mailbox' }, { status: 400 })
  try { return NextResponse.json(await mailboxes.ownerView(session.user.id, mailboxId)) }
  catch (error) { if (error instanceof MailboxError) return NextResponse.json({ error: error.message }, { status: error.status }); throw error }
}
