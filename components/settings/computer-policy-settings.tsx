'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { z } from 'zod'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { withBasePath } from '@/lib/base-path'

const stateSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), permission: z.enum(['allow', 'ask', 'deny']), canEdit: z.boolean() }),
])
type State = z.infer<typeof stateSchema>

export function ComputerPolicySettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.computerPolicy')
  const approval = useTranslations('Computer.approval')
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
  async function change(permission: 'allow' | 'ask' | 'deny') {
    setPending(true); setError(false)
    try {
      const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ permission }) })
      if (!response.ok) throw new Error('Computer policy unavailable')
      await refresh()
    } catch { setError(true); await refresh().catch(() => undefined) } finally { setPending(false) }
  }
  const labels = { allow: approval('allow'), ask: t('ask'), deny: t('deny') }
  if (!state) return error ? <p role="alert" className="text-sm text-destructive">{t('error')}</p> : <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>
  if (!state.enabled) return <p role="status" className="text-sm text-muted-foreground">{t('unavailable')}</p>
  return <div className="flex flex-col gap-2">
    <SettingsSection id="computer-policy-heading" title={t('heading')} description={t('description')}>
      <SettingRow title={t('label')} description={state.canEdit ? t('help') : t('adminOnly')}>
        {/* Only an admin can change it; everyone else sees the value, not a disabled control. */}
        {state.canEdit
          ? <ToggleGroup aria-label={t('label')} variant="outline" spacing={0} disabled={pending} value={[state.permission]} onValueChange={values => { const value = values[0]; if ((value === 'allow' || value === 'ask' || value === 'deny') && value !== state.permission) void change(value) }}>
            <ToggleGroupItem value="allow">{labels.allow}</ToggleGroupItem><ToggleGroupItem value="ask">{labels.ask}</ToggleGroupItem><ToggleGroupItem value="deny">{labels.deny}</ToggleGroupItem>
          </ToggleGroup>
          : <span className="text-sm">{labels[state.permission]}</span>}
      </SettingRow>
    </SettingsSection>
    {error && <p role="alert" className="px-1 text-sm text-destructive">{t('error')}</p>}
  </div>
}
