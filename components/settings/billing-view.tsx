'use client'

import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { SettingRow, SettingsLoading, SettingsSection } from '@/components/settings/primitives'
import { BalanceSection } from '@/components/billing/balance-section'
import { FreeAllowanceSection } from '@/components/billing/free-allowance-section'
import type { SettingsBillingProps } from '@/components/slots/settings-billing-contract'
import { useActionError } from '@/lib/use-action-error'
import { FieldError } from '@/components/ui/field'

/**
 * V15 计费, the open-source page. No embedded card or tax forms (WS-20~22
 * dropped): the plan goes through Stripe Checkout, payment method, plan changes
 * and invoices through the Customer Portal.
 */
export function BillingPageView({ plan: planState, balance, allowance, computerBilling }: SettingsBillingProps) {
  const t = useTranslations('Settings.billing')
  const locale = useLocale()
  const actionError = useActionError()
  const { pending, actionError: error } = planState
  const data = planState.plan
  const number = new Intl.NumberFormat(locale)
  const date = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' })
  // 免费额度 and 余额 (#558, #559) come first, whether or not a plan is set up.
  const credits = <>
    {allowance && <FreeAllowanceSection allowance={allowance} />}
    <BalanceSection balance={balance} />
  </>

  if (planState.loading) return <SettingsLoading label={t('loading')} rows={3} />
  if (!data) return <FieldError>{planState.error}</FieldError>
  // No Stripe: card verification and 充值 cannot work, so only the state shows (and a balance already granted, read-only).
  if (!data.configured) return <>
    <BalanceSection balance={balance} purchasable={false} />
    <p role="status" className="text-sm text-muted-foreground">{actionError('billingNotConfigured')}</p>
  </>

  const planLine = data.live
    ? [t(`status.${data.status}` as never), data.currentPeriodEnd ? t('renews', { date: date.format(new Date(data.currentPeriodEnd)) }) : null].filter(Boolean).join(' · ')
    : t('noPlan')

  return <>
    {credits}
    <SettingsSection id="billing-plan" title={t('plan')}>
      <SettingRow title={data.live ? data.plan ?? t('team') : t('free')} description={planLine}>
        {data.live
          ? <Button type="button" variant="secondary" size="sm" disabled={pending !== null} onClick={planState.openPortal}>{t('changePlan')}</Button>
          : <Button type="button" size="sm" disabled={pending !== null || !data.resourceCheckoutAvailable} onClick={planState.startCheckout}>{t('subscribe')}</Button>}
      </SettingRow>
      <SettingRow title={t('members')} description={t('membersNotBilled')}><span>{number.format(data.members)}</span></SettingRow>
      {data.billingModel === 'legacy_seat' && data.live && <p className="px-5 pb-4 text-sm text-muted-foreground">{t('legacySubscription')}</p>}
      {!data.live && !data.resourceCheckoutAvailable && <p role="status" className="px-5 pb-4 text-sm text-muted-foreground">{actionError('billingResourcePlanUnavailable')}</p>}
      {data.autoRecharge?.state === 'provider_unsupported' && <SettingRow title={t('autoRecharge')} description={actionError('billingAutoRechargeUnavailable')} />}
    </SettingsSection>

    {computerBilling && (data.planPoints !== null || data.purchasedPoints > 0) && <SettingsSection id="billing-points" title={t('points')}>
      {data.planPoints !== null && <SettingRow title={t('planPoints')}><span>{t('pointsValue', { points: number.format(data.planPoints) })}</span></SettingRow>}
      {data.purchasedPoints > 0 && <SettingRow title={t('purchasedPoints')} description={t('neverExpires')}><span>{t('pointsValue', { points: number.format(data.purchasedPoints) })}</span></SettingRow>}
    </SettingsSection>}

    {data.hasCustomer && <SettingsSection id="billing-payment" title={t('payment')}>
      <SettingRow title={t('paymentMethod')}>
        <Button type="button" variant="secondary" size="sm" disabled={pending !== null} onClick={planState.openPortal}>{t('managePayment')}</Button>
      </SettingRow>
      <SettingRow title={t('invoices')}>
        <Button type="button" variant="secondary" size="sm" disabled={pending !== null} onClick={planState.openPortal}>{t('viewInvoices')}</Button>
      </SettingRow>
    </SettingsSection>}
    {error && <FieldError className="px-1">{error}</FieldError>}
  </>
}
