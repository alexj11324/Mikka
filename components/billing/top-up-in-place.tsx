'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useLocale, useTranslations } from 'next-intl'
import { loadStripe } from '@stripe/stripe-js/pure'
import type { StripeEmbeddedCheckout } from '@stripe/stripe-js'
import { startChatPointsPurchase } from '@/app/actions/billing'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { POINTS_PER_USD, POINTS_PURCHASE_AMOUNTS } from '@/lib/billing/hosted-usage'
import { useActionError } from '@/lib/use-action-error'

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY

/**
 * 充值 on a refused Mikka 默认 turn (decision 2026-11-02-1450, 「同一页完成」).
 * With a publishable key the payment opens in a dialog on the chat, and the
 * turn runs again when it completes. Without one, Stripe's page takes it and
 * comes back to this chat, which runs the turn again (`useTopUpReturn`).
 */
export function TopUpInPlace({ botId, label, onPaid }: { botId: string | null; label: string; onPaid: () => unknown }) {
  const t = useTranslations('Billing.balance')
  const actionError = useActionError()
  const locale = useLocale()
  const number = new Intl.NumberFormat(locale)
  const usd = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' })
  const [pending, setPending] = useState(false)
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  async function buy(amount: number) {
    if (pending) return
    setPending(true)
    try {
      const result = await startChatPointsPurchase(amount, botId)
      if (result.error) { toast.error(result.error === 'billingNotConfigured' ? t('unavailable') : actionError(result.error)); return }
      if ('clientSecret' in result) setClientSecret(result.clientSecret)
      else { window.location.assign(result.url); return }
    } catch { toast.error(actionError('billingProviderFailed')) } finally { setPending(false) }
  }
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" size="sm" disabled={pending} />}>{label}</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          {POINTS_PURCHASE_AMOUNTS.map(amount => <DropdownMenuItem key={amount} onClick={() => { void buy(amount) }}>
            {t('amount', { amount: usd.format(amount), points: number.format(amount * POINTS_PER_USD) })}
          </DropdownMenuItem>)}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    {clientSecret && <EmbeddedTopUp clientSecret={clientSecret} title={label} onClose={() => setClientSecret(null)} onComplete={() => { setClientSecret(null); void onPaid() }} />}
  </>
}

/** Stripe's embedded Checkout in a dialog; it closes itself once the payment completes. */
function EmbeddedTopUp({ clientSecret, title, onClose, onComplete }: { clientSecret: string; title: string; onClose: () => void; onComplete: () => void }) {
  const mount = useRef<HTMLDivElement>(null)
  const done = useRef(onComplete)
  done.current = onComplete
  useEffect(() => {
    let checkout: StripeEmbeddedCheckout | null = null
    let cancelled = false
    void (async () => {
      const stripe = PUBLISHABLE_KEY ? await loadStripe(PUBLISHABLE_KEY) : null
      if (!stripe || cancelled || !mount.current) return
      checkout = await stripe.createEmbeddedCheckoutPage({ clientSecret, onComplete: () => done.current() })
      if (cancelled) checkout.destroy()
      else checkout.mount(mount.current)
    })()
    return () => { cancelled = true; checkout?.destroy() }
  }, [clientSecret])
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
      <DialogTitle className="sr-only">{title}</DialogTitle>
      <div ref={mount} data-testid="embedded-top-up" className="min-h-96" />
    </DialogContent>
  </Dialog>
}
