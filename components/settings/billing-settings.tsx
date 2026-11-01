'use client'

import { useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import { openBillingPortal, startPlanCheckout, type getBilling } from '@/app/actions/billing'
import { settingsRead } from '@/lib/settings-read'
import { Button } from '@/components/ui/button'
import { SettingRow, SettingsLoading, SettingsSection } from '@/components/settings/primitives'
import { BalanceSection, creditBillingKey } from '@/components/billing/balance-section'
import { FreeAllowanceSection } from '@/components/billing/free-allowance-section'
import { useGatedFeature } from '@/hooks/use-feature-availability'
import { useActionError } from '@/lib/use-action-error'
import { FieldError } from '@/components/ui/field'

/**
 * V15 计费. No embedded card or tax forms (WS-20~22 dropped): the plan goes
 * through Stripe Checkout, payment method, plan changes and invoices through
 * the Customer Portal.
 */
export function BillingSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.billing')
  const computerBilling = useGatedFeature('computerBilling')
  const locale = useLocale()
  const actionError = useActionError()
  const billing = useSWR(['settings:billing', workspaceId], () => settingsRead<Awaited<ReturnType<typeof getBilling>>>('billing', { workspace: workspaceId }))
  const { mutate } = useSWRConfig()
  // 免费额度 and 余额 (#558, #559) come first, whether or not a plan is set up.
  const credits = <>
    <FreeAllowanceSection workspaceId={workspaceId} onVerified={() => { void mutate(creditBillingKey(workspaceId)) }} />
    <BalanceSection workspaceId={workspaceId} />
  </>
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
  if (!data) return <FieldError>{actionError(billing.data?.error)}</FieldError>
  // No Stripe: card verification and 充值 cannot work, so only the state shows (and a balance already granted, read-only).
  if (!data.configured) return <>
    <BalanceSection workspaceId={workspaceId} purchasable={false} />
    <p role="status" className="text-sm text-muted-foreground">{actionError('billingNotConfigured')}</p>
  </>

  const planLine = data.live
    ? [t(`status.${data.status}` as never), data.currentPeriodEnd ? t('renews', { date: date.format(new Date(data.currentPeriodEnd)) }) : null].filter(Boolean).join(' · ')
    : t('noPlan')

  return <>
    {credits}
    <SettingsSection id="billing-plan" title={t('plan')}>
      <SettingRow title={data.live ? data.plan ?? t('team') : t('free')} description={planLine}>
        {data.live || data.hasCustomer
          ? <Button type="button" variant="secondary" size="sm" disabled={pending !== null} onClick={() => void redirect('portal')}>{t('changePlan')}</Button>
          : <Button type="button" size="sm" disabled={pending !== null} onClick={() => void redirect('checkout')}>{t('subscribe')}</Button>}
      </SettingRow>
      {data.live && <SettingRow title={t('seats')}><span>{t('seatsUsed', { used: data.members, total: data.seats })}</span></SettingRow>}
    </SettingsSection>

    {computerBilling && (data.planPoints !== null || data.purchasedPoints > 0) && <SettingsSection id="billing-points" title={t('points')}>
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
    {error && <FieldError className="px-1">{error}</FieldError>}
  </>
}
