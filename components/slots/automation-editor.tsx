'use client'

// The default automation-editor slot (docs/ui-overlay.md): the run-settings section as Settings rows.
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import type { AutomationSettingControl, AutomationSettingsProps } from '@/components/slots/automation-editor-contract'

export function AutomationSettings({ id, title, rows, disabled }: AutomationSettingsProps) {
  return <SettingsSection id={id} title={title}>
    {rows.map(row => 'content' in row ? <div key={row.id}>{row.content}</div>
      : <SettingRow key={row.id} title={row.label}>
        <div className="flex flex-wrap items-center justify-end gap-2">{row.controls.map((control, index) => <Control key={index} control={control} disabled={disabled} />)}</div>
      </SettingRow>)}
  </SettingsSection>
}

function Control({ control, disabled }: { control: AutomationSettingControl; disabled?: boolean }) {
  const off = disabled || control.disabled
  if (control.kind === 'switch') return <Switch aria-label={control.label} checked={control.checked} disabled={off} onCheckedChange={control.onChange} />
  if (control.kind === 'button') return <Button size="sm" variant="outline" disabled={off} onClick={control.onClick}>{control.label}</Button>
  return <NativeSelect aria-label={control.label} value={control.value} disabled={off} onChange={event => control.onChange(event.target.value)}>
    {control.options.map(option => <NativeSelectOption key={option.value} value={option.value} disabled={option.disabled}>{option.label}</NativeSelectOption>)}
  </NativeSelect>
}
