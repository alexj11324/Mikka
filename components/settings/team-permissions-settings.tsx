'use client'

import { settingsKeys } from '@/lib/swr/keys'
import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { updateAppPolicy, type getAppPolicy } from '@/app/actions/app-policy'
import { updateSharePolicy, type getSharePolicy } from '@/app/actions/personal-policy'
import { settingsRead } from '@/lib/settings-read'
import { AppTile } from '@/components/plugins/connected-apps'
import { ComputerPolicySettings } from '@/components/settings/computer-policy-settings'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { APP_ACCESS, type AppAccess, type PolicyApp } from '@/lib/app-policy/apps'
import { useActionError } from '@/lib/use-action-error'
import { FieldError } from '@/components/ui/field'

/**
 * N4 团队权限: 电脑操作, whether members may share their subscriptions and API keys with teammates,
 * then which connected apps the workspace's bots may use. A member's own use has no switch (decision 2026-11-01-2240).
 */
export function TeamPermissionsSettings({ workspaceId }: { workspaceId: string }) {
  return <>
    <ComputerPolicySettings workspaceId={workspaceId} />
    <SharePolicySettings workspaceId={workspaceId} />
    <AppPolicySettings workspaceId={workspaceId} />
  </>
}

/** 订阅与 API Key: the one thing an admin can turn off, sharing with teammates; 允许 by default (decision 2026-11-01-2240). */
function SharePolicySettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.sharePolicy')
  const appT = useTranslations('Settings.appPolicy')
  const commonT = useTranslations('Common')
  const actionError = useActionError()
  const policy = useSWR(settingsKeys.sharePolicy(workspaceId), () => settingsRead<Awaited<ReturnType<typeof getSharePolicy>>>('share-policy', { workspace: workspaceId }))
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<{ access: AppAccess; message: string } | null>(null)
  const data = policy.data && !policy.data.error ? policy.data : null
  const access: AppAccess = data?.allowed === false ? 'deny' : 'allow'

  async function change(next: AppAccess) {
    setPending(true)
    setFailed(null)
    try {
      const result = await updateSharePolicy(next === 'allow', workspaceId)
      if (result.error) { setFailed({ access: next, message: actionError(result.error) }); return }
      await policy.mutate(result, { revalidate: false })
    } catch {
      setFailed({ access: next, message: actionError() })
    } finally {
      setPending(false)
    }
  }

  if (!policy.data && !policy.error) return <SettingsLoading label={t('loading')} rows={1} />
  if (!data) return <FieldError>{actionError(policy.data?.error)}</FieldError>
  return <>
    <SettingsSection id="share-policy-heading" title={t('heading')}>
      <SettingRow title={t('label')} description={t('detail')}>
        {data.canEdit
          ? <ToggleGroup aria-label={t('label')} variant="segment" spacing={0.5} disabled={pending} value={[access]} onValueChange={values => { const value = values[0]; if ((value === 'allow' || value === 'deny') && value !== access) void change(value) }}>
            {APP_ACCESS.map(value => <ToggleGroupItem key={value} value={value}>{appT(`access.${value}`)}</ToggleGroupItem>)}
          </ToggleGroup>
          : <span>{appT(`access.${access}`)}</span>}
      </SettingRow>
    </SettingsSection>
    {failed && <SettingsSaveError message={failed.message} retryLabel={commonT('retry')} onRetry={() => void change(failed.access)} />}
  </>
}

function AppPolicySettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.appPolicy')
  const commonT = useTranslations('Common')
  const actionError = useActionError()
  const policy = useSWR(settingsKeys.appPolicy(workspaceId), () => settingsRead<Awaited<ReturnType<typeof getAppPolicy>>>('app-policy', { workspace: workspaceId }))
  const [pending, setPending] = useState<PolicyApp | null>(null)
  const [failed, setFailed] = useState<{ app: PolicyApp; access: AppAccess; message: string } | null>(null)
  const data = policy.data && !policy.data.error ? policy.data : null

  async function change(app: PolicyApp, access: AppAccess) {
    setPending(app)
    setFailed(null)
    try {
      const result = await updateAppPolicy({ app, access }, workspaceId)
      // S-O: the select keeps the saved value; 重试 sends the same change.
      if (result.error) { setFailed({ app, access, message: actionError(result.error) }); return }
      await policy.mutate(result, { revalidate: false })
    } catch {
      setFailed({ app, access, message: actionError() })
    } finally {
      setPending(null)
    }
  }

  if (!policy.data && !policy.error) return <SettingsLoading label={t('loading')} rows={4} />
  if (!data) return <FieldError>{actionError(policy.data?.error)}</FieldError>
  return <>
    <SettingsSection id="app-policy-heading" title={t('heading')}>
      {data.apps.map(({ app, access }) => <SettingRow key={app} title={t(`apps.${app}`)} icon={<AppTile app={app} />}>
        {data.canEdit
          // The same 允许 / 禁止 control as 电脑操作 above (P2).
          ? <ToggleGroup aria-label={t(`apps.${app}`)} variant="segment" spacing={0.5} disabled={pending !== null} value={[access]} onValueChange={values => { const value = values[0]; if ((value === 'allow' || value === 'deny') && value !== access) void change(app, value) }}>
            {APP_ACCESS.map(value => <ToggleGroupItem key={value} value={value}>{t(`access.${value}`)}</ToggleGroupItem>)}
          </ToggleGroup>
          : <span>{t(`access.${access}`)}</span>}
      </SettingRow>)}
    </SettingsSection>
    {failed && <SettingsSaveError message={failed.message} retryLabel={commonT('retry')} onRetry={() => void change(failed.app, failed.access)} />}
  </>
}
