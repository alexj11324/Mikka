'use client'

import { useTranslations } from 'next-intl'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { PersonalSecretsSettings } from '@/components/settings/personal-secrets-settings'
import { SavedLoginsSettings } from '@/components/settings/saved-logins-settings'
import { SecretsSettings } from '@/components/settings/secrets-settings'
import type { SettingsSecretsProps } from '@/components/slots/settings-secrets-contract'

/**
 * 密钥与登录: one page with a switch at the top between the person's own secrets and logins and
 * the current workspace's (Devin's 「Secrets for」; decision 2026-11-02-2120). Both sidebar entries,
 * 账号 › 密钥与登录 and 工作区 › 密钥与环境, open it, each on its own side.
 */
export function SecretsPage({ side, onSide, workspaceId, workspaceName, waiting }: SettingsSecretsProps) {
  const t = useTranslations('Settings.secrets')
  return <>
    <ToggleGroup aria-label={t('side.label')} variant="segment" size="sm" spacing={0.5} className="self-start" value={[side]} onValueChange={values => { const next = values[0] as SettingsSecretsProps['side'] | undefined; if (next) onSide(next) }}>
      <ToggleGroupItem value="mine">{t('side.mine')}</ToggleGroupItem>
      <ToggleGroupItem value="workspace">{workspaceName ?? t('workspaceGroup')}</ToggleGroupItem>
    </ToggleGroup>
    {side === 'mine' ? <>{workspaceId && <PersonalSecretsSettings key={workspaceId} workspaceId={workspaceId} workspaceName={workspaceName} />}<SavedLoginsSettings /></> : workspaceId ? <SecretsSettings key={workspaceId} workspaceId={workspaceId} workspaceName={workspaceName} /> : waiting}
  </>
}
