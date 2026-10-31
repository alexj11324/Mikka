import { NextResponse } from 'next/server'
import { z, ZodError } from 'zod'
import { applyStripeEvent } from '@/lib/billing/service'
import { stripeConfig, verifyStripeSignature } from '@/lib/billing/stripe'

export const runtime = 'nodejs'

/** Stripe webhook: records subscription state for 计费. Signature-checked; idempotent by event id. */
export async function POST(request: Request) {
  const secret = stripeConfig()?.webhookSecret
  if (!secret) return new NextResponse(null, { status: 404 })
  const body = await request.text()
  if (!verifyStripeSignature(body, request.headers.get('stripe-signature'), secret)) return new NextResponse(null, { status: 400 })
  try {
    const event = JSON.parse(body)
    if (event.type === 'setup_intent.succeeded') {
      await (await import('@/lib/abuse/card')).applyCardSetup(z.object({data:z.object({object:z.record(z.string(),z.unknown())})}).parse(event).data.object)
    } else if (event.type === 'checkout.session.completed' && event.data?.object?.mode === 'setup') {
      await (await import('@/lib/abuse/card')).applyCardCheckout(z.object({data:z.object({object:z.record(z.string(),z.unknown())})}).parse(event).data.object)
    } else await applyStripeEvent(event)
  } catch (error) {
    // A malformed event is refused for good; anything else (the database) is a 500 so Stripe retries.
    if (!(error instanceof ZodError || error instanceof SyntaxError)) throw error
    console.error('[billing] webhook event rejected', { name: error.name })
    return new NextResponse(null, { status: 400 })
  }
  return NextResponse.json({ received: true })
}
