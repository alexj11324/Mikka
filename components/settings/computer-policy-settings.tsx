'use client'

import { useTranslations } from 'next-intl'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { FieldError } from '@/components/ui/field'
import { useComputerPolicy } from '@/hooks/settings/use-team-permissions'

export { computerPolicyKey, readComputerPolicy } from '@/hooks/settings/use-team-permissions'

export function ComputerPolicySettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.computerPolicy')
  const { state, error, pending, change } = useComputerPolicy(workspaceId)
  const labels = { allow: t('allow'), deny: t('deny') }
  if (!state) return error ? <FieldError>{t('error')}</FieldError> : <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>
  // No cloud computer on this deployment: there is no row to set, and a line saying so would sit apart from everything below it (R-40).
  if (!state.enabled) return null
  return <div className="flex flex-col gap-2">
    <SettingsSection id="computer-policy-heading" title={t('heading')}>
      <SettingRow title={t('label')}>
        {/* Only an admin can change it; everyone else sees the value, not a disabled control. */}
        {state.canEdit
          ? <ToggleGroup aria-label={t('label')} variant="segment" spacing={0.5} disabled={pending} value={[state.permission]} onValueChange={values => { const value = values[0]; if ((value === 'allow' || value === 'deny') && value !== state.permission) void change(value) }}>
            <ToggleGroupItem value="allow">{labels.allow}</ToggleGroupItem><ToggleGroupItem value="deny">{labels.deny}</ToggleGroupItem>
          </ToggleGroup>
          : <span className="text-sm">{labels[state.permission]}</span>}
      </SettingRow>
    </SettingsSection>
    {error && <FieldError className="px-1">{t('error')}</FieldError>}
  </div>
}
