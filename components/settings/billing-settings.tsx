'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import { getBilling, openBillingPortal, startPlanCheckout } from '@/app/actions/billing'
import { Button } from '@/components/ui/button'
import { SettingRow, SettingsLoading, SettingsSection } from '@/components/settings/primitives'
import { useActionError } from '@/lib/use-action-error'

/**
 * V15 计费. No embedded card or tax forms (WS-20~22 dropped): the plan goes
 * through Stripe Checkout, payment method, plan changes and invoices through
 * the Customer Portal.
 */
export function BillingSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.billing')
  const locale = useLocale()
  const actionError = useActionError()
  const billing = useSWR(['settings:billing', workspaceId], () => getBilling(workspaceId))
  const [pending, setPending] = useState<'portal' | 'checkout' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const data = billing.data && !billing.data.error ? billing.data : null
  const number = new Intl.NumberFormat(locale)
  const date = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' })

  async function redirect(kind: 'portal' | 'checkout') {
    setPending(kind)
    setError(null)
    try {
      const back = window.location.href
      const result = kind === 'portal' ? await openBillingPortal(back, workspaceId) : await startPlanCheckout(back, workspaceId)
      if (result.error) { setError(actionError(result.error)); setPending(null); return }
      window.location.assign(result.url)
    } catch {
      setError(actionError('billingProviderFailed'))
      setPending(null)
    }
  }

  if (!billing.data && !billing.error) return <SettingsLoading label={t('loading')} rows={3} />
  if (!data) return <p role="alert" className="text-sm text-destructive">{actionError(billing.data?.error)}</p>
  if (!data.configured) return <p role="status" className="text-sm text-muted-foreground">{actionError('billingNotConfigured')}</p>

  const planLine = data.live
    ? [t(`status.${data.status}` as never), data.currentPeriodEnd ? t('renews', { date: date.format(new Date(data.currentPeriodEnd)) }) : null].filter(Boolean).join(' · ')
    : t('noPlan')

  return <>
    <SettingsSection id="billing-plan" title={t('plan')}>
      <SettingRow title={data.live ? data.plan ?? t('team') : t('free')} description={planLine}>
        {data.live || data.hasCustomer
          ? <Button type="button" variant="secondary" size="sm" disabled={pending !== null} onClick={() => void redirect('portal')}>{t('changePlan')}</Button>
          : <Button type="button" size="sm" disabled={pending !== null} onClick={() => void redirect('checkout')}>{t('subscribe')}</Button>}
      </SettingRow>
      {data.live && <SettingRow title={t('seats')}><span>{t('seatsUsed', { used: data.members, total: data.seats })}</span></SettingRow>}
    </SettingsSection>

    {(data.planPoints !== null || data.purchasedPoints > 0) && <SettingsSection id="billing-points" title={t('points')}>
      {data.planPoints !== null && <SettingRow title={t('planPoints')}><span>{t('pointsValue', { points: number.format(data.planPoints) })}</span></SettingRow>}
      {data.purchasedPoints > 0 && <SettingRow title={t('purchasedPoints')} description={t('neverExpires')}><span>{t('pointsValue', { points: number.format(data.purchasedPoints) })}</span></SettingRow>}
    </SettingsSection>}

    {data.hasCustomer && <SettingsSection id="billing-payment" title={t('payment')}>
      <SettingRow title={t('paymentMethod')}>
        <Button type="button" variant="secondary" size="sm" disabled={pending !== null} onClick={() => void redirect('portal')}>{t('managePayment')}</Button>
      </SettingRow>
      <SettingRow title={t('invoices')}>
        <Button type="button" variant="secondary" size="sm" disabled={pending !== null} onClick={() => void redirect('portal')}>{t('viewInvoices')}</Button>
      </SettingRow>
    </SettingsSection>}
    {error && <p role="alert" className="px-1 text-sm text-destructive">{error}</p>}
  </>
}
