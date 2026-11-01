'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { getCreditShare, getPaymentDesignation, updateCreditShare, updatePaymentDesignation } from '@/app/actions/personal-policy'
import { SettingRow, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { Switch } from '@/components/ui/switch'
import { useActionError } from '@/lib/use-action-error'

/**
 * 由我的卡支付这个团队: a member pays for a team with their own verified card.
 * Stopping it, or leaving, keeps the card paying through a grace period, which
 * admins see here and on 计费 (decision 2026-10-31-2225). Nothing shows in a
 * personal workspace or to a member without a card.
 */
export function PaymentDesignationSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.paymentDesignation')
  const shareT = useTranslations('Settings.creditShare')
  const commonT = useTranslations('Common')
  const format = useFormatter()
  const actionError = useActionError()
  const designation = useSWR(['settings:payment-designation', workspaceId], () => getPaymentDesignation(workspaceId))
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<{ designated: boolean; message: string; share?: boolean } | null>(null)
  const data = designation.data && !designation.data.error ? designation.data : null
  // 我的点数也可用于这个团队 (decision 2026-10-31-2300 item 4): any member of a team, in the same 付款 section.
  const share = useSWR(['settings:credit-share', workspaceId], () => getCreditShare(workspaceId))
  const shareData = share.data && !share.data.error ? share.data : null
  const [sharePending, setSharePending] = useState(false)

  async function changeShare(shared: boolean) {
    setSharePending(true)
    setFailed(null)
    try {
      const result = await updateCreditShare(shared, workspaceId)
      if (result.error) { setFailed({ designated: shared, message: actionError(result.error), share: true }); return }
      await share.mutate(result, { revalidate: false })
    } catch {
      setFailed({ designated: shared, message: actionError(), share: true })
    } finally {
      setSharePending(false)
    }
  }

  async function change(designated: boolean) {
    setPending(true)
    setFailed(null)
    try {
      const result = await updatePaymentDesignation(designated, workspaceId)
      if (result.error) { setFailed({ designated, message: actionError(result.error) }); return }
      await designation.mutate(result, { revalidate: false })
    } catch {
      setFailed({ designated, message: actionError() })
    } finally {
      setPending(false)
    }
  }

  const showsCard = Boolean(data && (data.canDesignate || data.mine || data.payerName || data.graceUntil))
  if (!showsCard && !shareData?.canShare) return null
  return <>
    <SettingsSection id="payment-designation-heading" title={t('heading')}>
      {data && (data.canDesignate || data.mine) && <SettingRow title={t('mine')}>
        <Switch aria-label={t('mine')} checked={data.mine} disabled={pending} onCheckedChange={designated => void change(designated)} />
      </SettingRow>}
      {shareData?.canShare && <SettingRow title={shareT('mine')}>
        <Switch aria-label={shareT('mine')} checked={shareData.mine} disabled={sharePending} onCheckedChange={shared => void changeShare(shared)} />
      </SettingRow>}
      {data?.admin && data.payerName && <SettingRow title={t('payer', { name: data.payerName })}>
        <span className="text-sm text-muted-foreground">{data.graceUntil ? t('until', { date: format.dateTime(new Date(data.graceUntil), { dateStyle: 'medium' }) }) : t('active')}</span>
      </SettingRow>}
      {shareData?.admin && shareData.sharers.length > 0 && <SettingRow title={shareT('sharers')}>
        <span className="text-sm text-muted-foreground">{shareData.sharers.join('、')}</span>
      </SettingRow>}
    </SettingsSection>
    {failed && <SettingsSaveError message={failed.message} retryLabel={commonT('retry')} onRetry={() => void (failed.share ? changeShare(failed.designated) : change(failed.designated))} />}
  </>
}
