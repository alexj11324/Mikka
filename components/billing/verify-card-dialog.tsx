'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useTheme } from 'next-themes'
import { LockKeyhole } from 'lucide-react'
import { loadStripe } from '@stripe/stripe-js/pure'
import type { Stripe, StripeElements } from '@stripe/stripe-js'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { getHostedUsage, startCardVerification, STRIPE_PUBLISHABLE_KEY, waitForVerification, type HostedUsage } from '@/lib/billing/verification-client'
import { useActionError } from '@/lib/use-action-error'
import { cn } from '@/lib/utils'

type Phase = 'loading' | 'ready' | 'submitting' | 'confirming' | 'unconfirmed' | 'unavailable' | 'failed'

/**
 * 验证银行卡 (#523): a $0 Stripe SetupIntent in the Payment Element. Nothing is
 * charged; Stripe's webhook records the card and grants the one-off allowance,
 * so success here only means Stripe accepted the card. Closes with the usage
 * the server reports once it has the verification, or null.
 */
export function VerifyCardDialog({ workspaceId, onClose }: { workspaceId?: string; onClose: (verified: HostedUsage | null) => void }) {
  const t = useTranslations('Billing.verify')
  const locale = useLocale()
  const { resolvedTheme } = useTheme()
  const actionError = useActionError()
  const mount = useRef<HTMLDivElement>(null)
  const stripe = useRef<{ stripe: Stripe; elements: StripeElements } | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<string | null>(null)
  const dark = resolvedTheme === 'dark'

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // Stripe not set up on the server, or no publishable key in this build: 暂不可用.
        if (!STRIPE_PUBLISHABLE_KEY) { setPhase('unavailable'); return }
        const setup = await startCardVerification(workspaceId)
        if (cancelled) return
        if (setup.error === 'billingNotConfigured') { setPhase('unavailable'); return }
        if (setup.error) { setPhase('failed'); setError(actionError(setup.error)); return }
        const loaded = await loadStripe(STRIPE_PUBLISHABLE_KEY)
        if (cancelled) return
        if (!loaded || !mount.current) { setPhase('failed'); setError(actionError('billingProviderFailed')); return }
        const elements = loaded.elements({
          clientSecret: setup.clientSecret,
          locale: locale === 'zh-CN' ? 'zh' : 'en',
          appearance: { theme: dark ? 'night' : 'stripe', variables: { borderRadius: '8px', fontSizeBase: '13px' } },
        })
        elements.create('payment', { ...setup.paymentElementOptions, layout: 'tabs' }).mount(mount.current)
        stripe.current = { stripe: loaded, elements }
        setPhase('ready')
      } catch {
        if (!cancelled) { setPhase('failed'); setError(actionError('billingProviderFailed')) }
      }
    })()
    return () => { cancelled = true; stripe.current?.elements.getElement('payment')?.destroy() }
    // The intent is created once per opening; a theme or locale change keeps the mounted form.
  }, [workspaceId])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const current = stripe.current
    if (!current || phase !== 'ready') return
    setPhase('submitting')
    setError(null)
    try {
      const checked = await current.elements.submit()
      if (checked.error) { setError(checked.error.message ?? t('failed')); setPhase('ready'); return }
      const result = await current.stripe.confirmSetup({ elements: current.elements, confirmParams: { return_url: window.location.href }, redirect: 'if_required' })
      if (result.error) { setError(result.error.message ? t('failedWith', { reason: result.error.message }) : t('failed')); setPhase('ready'); return }
      setPhase('confirming')
      const usage = await waitForVerification(async () => {
        const read = await getHostedUsage(workspaceId)
        return read.error ? null : read
      })
      if (usage) onClose(usage)
      else setPhase('unconfirmed')
    } catch {
      setError(t('failed'))
      setPhase('ready')
    }
  }

  const busy = phase === 'submitting' || phase === 'confirming'
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(null) }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>{t('title')}</DialogTitle></DialogHeader>
      <form onSubmit={submit} className="flex flex-col gap-4" aria-busy={busy || phase === 'loading'}>
        {phase === 'loading' && <div role="status" aria-label={t('loading')} className="flex h-40 items-center justify-center"><Spinner /></div>}
        <div ref={mount} data-slot="stripe-payment" className={cn((phase === 'loading' || phase === 'unavailable' || phase === 'failed') && 'hidden')} />
        {phase === 'unavailable' && <p role="status" className="text-sm text-muted-foreground">{t('unavailable')}</p>}
        {phase !== 'unavailable' && phase !== 'failed' && <p data-slot="verify-terms" className="text-xs text-muted-foreground">{t('terms')}</p>}
        {phase === 'unconfirmed' && <p role="status" className="text-sm">{t('unconfirmed')}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter className="items-center sm:justify-between">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><LockKeyhole aria-hidden="true" className="size-3" />{t('secured')}</span>
          {/* The dialog's own ✕ closes it once nothing is left to submit. */}
          {phase !== 'unconfirmed' && phase !== 'unavailable' && phase !== 'failed' && <div className="flex gap-2">
            <Button type="button" variant="secondary" disabled={busy} onClick={() => onClose(null)}>{t('cancel')}</Button>
            <Button type="submit" disabled={phase !== 'ready'}>{busy && <Spinner data-icon="inline-start" />}{phase === 'confirming' ? t('confirming') : t('submit')}</Button>
          </div>}
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
