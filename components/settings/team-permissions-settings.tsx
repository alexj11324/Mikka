'use client'

import { useTranslations } from 'next-intl'
import * as permissionsSlot from '@ui-slot/settings-permissions'
import { AppTile } from '@/components/plugins/connected-apps'
import { ComputerPolicySettings } from '@/components/settings/computer-policy-settings'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { APP_ACCESS } from '@/lib/app-policy/apps'
import { FieldError } from '@/components/ui/field'
import { useAppPolicy, useComputerPolicy, useSharePolicy } from '@/hooks/settings/use-team-permissions'

/**
 * N4 团队权限: 电脑操作, whether members may share their subscriptions and API keys with teammates,
 * then which connected apps the workspace's bots may use. A member's own use has no switch (decision 2026-11-01-2240).
 * Reads and saves in hooks/settings/use-team-permissions.ts; a UI layer may draw the page (settings-permissions slot).
 */
export function TeamPermissionsSettings({ workspaceId }: { workspaceId: string }) {
  const Page = permissionsSlot.TeamPermissionsPage ?? null
  if (Page) return <LayerPage Page={Page} workspaceId={workspaceId} />
  return <>
    <ComputerPolicySettings workspaceId={workspaceId} />
    <SharePolicySettings workspaceId={workspaceId} />
    <AppPolicySettings workspaceId={workspaceId} />
  </>
}

function LayerPage({ Page, workspaceId }: { Page: NonNullable<typeof permissionsSlot.TeamPermissionsPage>; workspaceId: string }) {
  const computer = useComputerPolicy(workspaceId)
  const share = useSharePolicy(workspaceId)
  const apps = useAppPolicy(workspaceId)
  return <Page workspaceId={workspaceId} computer={computer} share={share} apps={apps} />
}

/** 订阅与 API Key: the one thing an admin can turn off, sharing with teammates; 允许 by default (decision 2026-11-01-2240). */
function SharePolicySettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.sharePolicy')
  const appT = useTranslations('Settings.appPolicy')
  const commonT = useTranslations('Common')
  const share = useSharePolicy(workspaceId)
  if (share.loading) return <SettingsLoading label={t('loading')} rows={1} />
  if (!share.data) return <FieldError>{share.error}</FieldError>
  return <>
    <SettingsSection id="share-policy-heading" title={t('heading')}>
      <SettingRow title={t('label')} description={t('detail')}>
        {share.canEdit
          ? <ToggleGroup aria-label={t('label')} variant="segment" spacing={0.5} disabled={share.pending} value={[share.access]} onValueChange={values => { const value = values[0]; if ((value === 'allow' || value === 'deny') && value !== share.access) void share.change(value) }}>
            {APP_ACCESS.map(value => <ToggleGroupItem key={value} value={value}>{appT(`access.${value}`)}</ToggleGroupItem>)}
          </ToggleGroup>
          : <span>{appT(`access.${share.access}`)}</span>}
      </SettingRow>
    </SettingsSection>
    {share.failed && <SettingsSaveError message={share.failed.message} retryLabel={commonT('retry')} onRetry={share.retry} />}
  </>
}

function AppPolicySettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.appPolicy')
  const commonT = useTranslations('Common')
  const policy = useAppPolicy(workspaceId)
  if (policy.loading) return <SettingsLoading label={t('loading')} rows={4} />
  if (!policy.data) return <FieldError>{policy.error}</FieldError>
  return <>
    <SettingsSection id="app-policy-heading" title={t('heading')}>
      {policy.apps.map(({ app, access }) => <SettingRow key={app} title={t(`apps.${app}`)} icon={<AppTile app={app} />}>
        {policy.canEdit
          // The same 允许 / 禁止 control as 电脑操作 above (P2).
          ? <ToggleGroup aria-label={t(`apps.${app}`)} variant="segment" spacing={0.5} disabled={policy.pending !== null} value={[access]} onValueChange={values => { const value = values[0]; if ((value === 'allow' || value === 'deny') && value !== access) void policy.change(app, value) }}>
            {APP_ACCESS.map(value => <ToggleGroupItem key={value} value={value}>{t(`access.${value}`)}</ToggleGroupItem>)}
          </ToggleGroup>
          : <span>{t(`access.${access}`)}</span>}
      </SettingRow>)}
    </SettingsSection>
    {policy.failed && <SettingsSaveError message={policy.failed.message} retryLabel={commonT('retry')} onRetry={policy.retry} />}
  </>
}
