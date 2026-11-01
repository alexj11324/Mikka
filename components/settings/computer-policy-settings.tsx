'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { z } from 'zod'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { withBasePath } from '@/lib/base-path'
import { computerPermissions, type ComputerPermission } from '@/lib/computer/permission'
import { FieldError } from '@/components/ui/field'

const stateSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), permission: z.enum(computerPermissions), canEdit: z.boolean() }),
])
type State = z.infer<typeof stateSchema>

const policyPath = (workspaceId: string) => withBasePath(`/api/workspaces/${encodeURIComponent(workspaceId)}/computer-policy`)
export const computerPolicyKey = (workspaceId: string) => ['settings:computer-policy', workspaceId] as const
export async function readComputerPolicy(workspaceId: string): Promise<State> {
  const response = await fetch(policyPath(workspaceId), { cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok) throw new Error('Computer policy unavailable')
  return stateSchema.parse(await response.json())
}

export function ComputerPolicySettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.computerPolicy')
  const policy = useSWR(computerPolicyKey(workspaceId), () => readComputerPolicy(workspaceId))
  const state = policy.data ?? null
  const [pending, setPending] = useState(false)
  const [changeError, setChangeError] = useState(false)
  const error = changeError || Boolean(policy.error)
  const path = policyPath(workspaceId)
  const refresh = async () => { await policy.mutate() }
  async function change(permission: ComputerPermission) {
    setPending(true); setChangeError(false)
    try {
      const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ permission }) })
      if (!response.ok) throw new Error('Computer policy unavailable')
      await refresh()
    } catch { setChangeError(true); await refresh().catch(() => undefined) } finally { setPending(false) }
  }
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
