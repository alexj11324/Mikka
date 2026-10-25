import { after, NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyRunToken, workerRun } from '@/lib/mcp/worker'
import { mailboxes } from '@/lib/mailbox-runtime'
import { MailboxError } from '@/lib/session-mailbox'
import { mailboxAck, mailboxSend } from '@/lib/mailbox-tools'
import { wakeCoordinator } from '@/lib/coordinator/wake'

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('send'), ...mailboxSend.shape }),
  z.object({ action: z.literal('ack'), ...mailboxAck.shape }),
  z.object({ action: z.enum(['inbox', 'recipients', 'sent']) }),
])
export async function POST(request: Request) {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1]
  const auth = await verifyRunToken(request, token)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const parsed = requestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid mailbox request' }, { status: 400 })
  try {
    const run = workerRun(auth)
    const actor = await mailboxes.run(run.userId, run.id)
    const input = parsed.data
    let result: unknown
    switch (input.action) {
      case 'send': result = await mailboxes.send(actor, input); after(() => wakeCoordinator(run.userId)); break
      case 'ack': result = await mailboxes.ack(actor, input.ids); break
      case 'inbox': result = await mailboxes.inbox(actor); break
      case 'recipients': result = await mailboxes.recipients(actor); break
      case 'sent': result = await mailboxes.sent(actor); break
    }
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof MailboxError) return NextResponse.json({ error: error.message }, { status: error.status })
    throw error
  }
}
