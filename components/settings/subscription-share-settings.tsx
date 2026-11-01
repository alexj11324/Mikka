'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { getSubscriptionShare, updateSubscriptionShare } from '@/app/actions/personal-policy'
import { SettingRow, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Switch } from '@/components/ui/switch'
import { FieldError } from '@/components/ui/field'
import { useActionError } from '@/lib/use-action-error'

type Change = { shared: boolean; allowOthers?: boolean }

/**
 * 在这里使用我的订阅: a member shares their own subscriptions into this team
 * workspace for their own bots; 分享给团队成员 lets other members' bots use
 * them too. Turning it on asks first, in Alex's words: whose quota pays, that
 * tasks may run on members' own computers while the credential stays on Mikka's
 * servers, and to share only with people you trust. Turning it off
 * takes effect at once, without asking. A personal
 * workspace always uses its owner's subscriptions, so it shows nothing here
 * (decision 2026-10-31-2225).
 */
export function SubscriptionShareSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.subscriptionShare')
  const commonT = useTranslations('Common')
  const actionError = useActionError()
  const share = useSWR(['settings:subscription-share', workspaceId], () => getSubscriptionShare(workspaceId))
  const [pending, setPending] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [failed, setFailed] = useState<{ change: Change; message: string } | null>(null)
  const data = share.data && !share.data.error ? share.data : null

  async function change(next: Change) {
    setPending(true)
    setFailed(null)
    try {
      const result = await updateSubscriptionShare(next, workspaceId)
      if (result.error) { setFailed({ change: next, message: actionError(result.error) }); return }
      await share.mutate(result, { revalidate: false })
    } catch {
      setFailed({ change: next, message: actionError() })
    } finally {
      setPending(false)
      setConfirming(false)
    }
  }

  if (share.data?.error) return <FieldError>{actionError(share.data.error)}</FieldError>
  if (!data || data.personal) return null
  const ownName = data.own.length
    ? data.own.map(provider => t('subscriptionName', { provider: t(`provider.${provider}`) })).join(t('listSeparator'))
    : t('ownFallback')
  return <>
    <SettingsSection id="subscription-share-heading" title={t('heading')}>
      <SettingRow title={t('share')}>
        {data.allowed
          ? <Switch aria-label={t('share')} checked={data.shared} disabled={pending} onCheckedChange={shared => void change({ shared })} />
          : <span className="text-sm text-muted-foreground">{t('blocked')}</span>}
      </SettingRow>
      {data.allowed && data.shared && <SettingRow title={t('others')} description={data.allowOthers ? t('othersOn') : undefined}>
        <Switch aria-label={t('others')} checked={data.allowOthers} disabled={pending}
          onCheckedChange={checked => { if (checked) setConfirming(true); else void change({ shared: true, allowOthers: false }) }} />
      </SettingRow>}
      {data.allowed && data.available.map(item => <SettingRow key={`${item.name}-${item.provider}`} title={t('available', { name: item.name, provider: t(`provider.${item.provider}`) })}>
        <span className="text-sm text-muted-foreground">{t('availableState')}</span>
      </SettingRow>)}
    </SettingsSection>
    {failed && <SettingsSaveError message={failed.message} retryLabel={commonT('retry')} onRetry={() => void change(failed.change)} />}
    <AlertDialog open={confirming} onOpenChange={open => { if (!open && !pending) setConfirming(false) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('othersTitle', { name: ownName })}</AlertDialogTitle>
          <AlertDialogDescription render={<div />}>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-left">
              <li>{t('othersUsage')}</li>
              <li>{t('othersRuntime')}</li>
              <li>{t('othersTrust')}</li>
            </ul>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={() => void change({ shared: true, allowOthers: true })}>{t('othersConfirm')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}
