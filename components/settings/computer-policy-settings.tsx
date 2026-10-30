'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { z } from 'zod'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { withBasePath } from '@/lib/base-path'
import { computerPermissions, type ComputerPermission } from '@/lib/computer/permission'

const stateSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), permission: z.enum(computerPermissions), canEdit: z.boolean() }),
])
type State = z.infer<typeof stateSchema>

export function ComputerPolicySettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.computerPolicy')
  const [state, setState] = useState<State | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const path = withBasePath(`/api/workspaces/${encodeURIComponent(workspaceId)}/computer-policy`)
  const refresh = useCallback(async () => {
    const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) throw new Error('Computer policy unavailable')
    setState(stateSchema.parse(await response.json()))
  }, [path])
  useEffect(() => { void refresh().catch(() => setError(true)) }, [refresh])
  async function change(permission: ComputerPermission) {
    setPending(true); setError(false)
    try {
      const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ permission }) })
      if (!response.ok) throw new Error('Computer policy unavailable')
      await refresh()
    } catch { setError(true); await refresh().catch(() => undefined) } finally { setPending(false) }
  }
  if (!state) return error ? <p role="alert" className="text-sm text-destructive">{t('error')}</p> : <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>
  if (!state.enabled) return <p role="status" className="text-sm text-muted-foreground">{t('unavailable')}</p>
  return <div className="flex flex-col gap-2">
    <SettingsSection id="computer-policy-heading" title={t('heading')}>
      <SettingRow title={t('label')} description={state.canEdit ? t('help') : t('adminOnly')}>
        <ToggleGroup aria-label={t('label')} variant="outline" spacing={0} disabled={!state.canEdit || pending} value={[state.permission]} onValueChange={values => { const value = values[0]; if ((value === 'allow' || value === 'deny') && value !== state.permission) void change(value) }}>
          <ToggleGroupItem value="allow">{t('allow')}</ToggleGroupItem><ToggleGroupItem value="deny">{t('deny')}</ToggleGroupItem>
        </ToggleGroup>
      </SettingRow>
    </SettingsSection>
    {error && <p role="alert" className="px-1 text-sm text-destructive">{t('error')}</p>}
  </div>
}
