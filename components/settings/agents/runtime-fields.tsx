'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Laptop } from 'lucide-react'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import type { DeviceView } from '@/app/actions/agents'
import { SUPPORTED_HARNESSES, type SupportedHarness } from '@/lib/db/schema'
import type { HarnessModel } from '@mikka/protocol/harness'
import { cn } from '@/lib/utils'
import { HARNESS_LABELS, HarnessIcon } from './agent-parts'

export interface Runtime {
  deviceId: string | null
  harness: SupportedHarness | null
  model: string | null
  effort: string | null
}

/** The models a device's harness reported; empty when it reported none or nothing is chosen. */
export function reportedModels(devices: DeviceView[], deviceId: string | null, harness: SupportedHarness | null): HarnessModel[] {
  if (!deviceId || !harness) return []
  const info = devices.find(device => device.id === deviceId)?.harnesses.find(item => item.harness === harness && item.installed)
  return info?.models ?? []
}

/**
 * The model entry the runtime points at. A null model is the CLI's default;
 * Claude reports that as its own `default` entry, so it is shown by that.
 */
export function currentModel(models: HarnessModel[], model: string | null): HarnessModel | undefined {
  return models.find(item => item.value === (model ?? 'default'))
}

const EFFORT_LABELS: Record<string, string> = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }

export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1)
}

/** "Opus · Medium": the chip on the detail header and the model column in the list. */
export function modelSummary(models: HarnessModel[], runtime: Runtime, fallback: string): string {
  const name = runtime.model ? currentModel(models, runtime.model)?.displayName || runtime.model : fallback
  return runtime.effort ? `${name} · ${effortLabel(runtime.effort)}` : name
}

/** Harnesses offered for a device: the ones it reports installed, or every supported one before a device is chosen. */
function harnessOptions(devices: DeviceView[], deviceId: string | null): SupportedHarness[] {
  const device = devices.find(item => item.id === deviceId)
  if (!device) return [...SUPPORTED_HARNESSES]
  return SUPPORTED_HARNESSES.filter(harness => device.harnesses.some(item => item.harness === harness && item.installed))
}

function Picker({ label, value, placeholder, options, onChange, disabled }: {
  label: string
  value: string | null
  placeholder: string
  options: { value: string; label: string; icon?: ReactNode; trailing?: ReactNode }[]
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const selected = options.find(option => option.value === value)
  return <Select value={value} onValueChange={next => { if (next !== null) onChange(next) }} disabled={disabled}>
    <SelectTrigger aria-label={label} className="h-9 w-full sm:w-70">
      <SelectValue>{() => selected ? <>{selected.icon}<span className="truncate">{selected.label}</span></> : <span className="text-muted-foreground">{placeholder}</span>}</SelectValue>
    </SelectTrigger>
    <SelectContent>
      <SelectGroup>
        {options.map(option => <SelectItem key={option.value} value={option.value}>{option.icon}<span className="flex-1 truncate">{option.label}</span>{option.trailing}</SelectItem>)}
      </SelectGroup>
    </SelectContent>
  </Select>
}

/**
 * The 运行环境 tab: machine, harness, model and reasoning effort. Every list
 * comes from what the chosen device's daemon reported, never from a list
 * written here.
 */
export function RuntimeFields({ devices, runtime, onChange }: { devices: DeviceView[]; runtime: Runtime; onChange: (next: Runtime) => void }) {
  const t = useTranslations('Agents.runtime')
  const enabledDevices = devices.filter(device => device.enabled || device.id === runtime.deviceId)
  const harnesses = harnessOptions(devices, runtime.deviceId)
  const models = reportedModels(devices, runtime.deviceId, runtime.harness)
  const model = currentModel(models, runtime.model)
  const levels = model?.efforts ?? []
  const effortIndex = runtime.effort ? levels.indexOf(runtime.effort) : -1

  const pickDevice = (deviceId: string) => {
    const keepHarness = runtime.harness && harnessOptions(devices, deviceId).includes(runtime.harness) ? runtime.harness : null
    const keepModel = keepHarness && reportedModels(devices, deviceId, keepHarness).some(item => item.value === runtime.model) ? runtime.model : null
    onChange({ deviceId, harness: keepHarness, model: keepModel, effort: keepModel === runtime.model ? runtime.effort : null })
  }
  const pickModel = (value: string) => {
    const next = models.find(item => item.value === value)
    onChange({ ...runtime, model: value, effort: runtime.effort && next?.efforts.includes(runtime.effort) ? runtime.effort : null })
  }

  return <SettingsSection>
    <SettingRow title={t('device')}>
      <Picker label={t('device')} value={runtime.deviceId} placeholder={enabledDevices.length ? t('pickDevice') : t('noDevices')} disabled={!enabledDevices.length} onChange={pickDevice}
        options={enabledDevices.map(device => ({
          value: device.id, label: device.name, icon: <Laptop aria-hidden="true" />,
          trailing: <span className={cn('size-1.5 rounded-full', device.online ? 'bg-success' : 'bg-ink-3')} aria-label={device.online ? t('online') : t('offline')} />,
        }))} />
    </SettingRow>
    <SettingRow title="Harness">
      <Picker label="Harness" value={runtime.harness} placeholder={harnesses.length ? t('pickHarness') : t('noHarness')} disabled={!harnesses.length}
        onChange={harness => onChange({ ...runtime, harness: harness as SupportedHarness, model: null, effort: null })}
        options={harnesses.map(harness => ({ value: harness, label: HARNESS_LABELS[harness], icon: <HarnessIcon harness={harness} size="md" /> }))} />
    </SettingRow>
    <SettingRow title={t('model')} description={runtime.harness && !models.length ? t('modelsUnreported') : undefined}>
      <Picker label={t('model')} value={model?.value ?? runtime.model} placeholder={t('defaultModel')} disabled={!models.length} onChange={pickModel}
        options={models.map(item => ({ value: item.value, label: item.displayName || item.value }))} />
    </SettingRow>
    <div className="flex flex-col gap-2.5 px-5 py-4">
      <div className="flex items-baseline gap-1.5 text-sm">
        <span className="text-muted-foreground">Effort</span>
        <span className="font-medium">{runtime.effort ? effortLabel(runtime.effort) : levels.length ? t('defaultEffort') : '—'}</span>
      </div>
      {levels.length > 0 ? <>
        <div className="flex justify-between text-xs text-muted-foreground"><span>Faster</span><span>Smarter</span></div>
        <ToggleGroup aria-label="Effort" spacing={0} className="h-9 w-full overflow-hidden rounded-lg bg-inset" value={runtime.effort ? [runtime.effort] : []}
          onValueChange={values => onChange({ ...runtime, effort: values[0] ?? null })}>
          {levels.map((level, index) => <ToggleGroupItem key={level} value={level} aria-label={effortLabel(level)}
            className={cn('h-9 flex-1 p-0 hover:bg-transparent aria-pressed:bg-transparent', index <= effortIndex && 'bg-hover-2 hover:bg-hover-2 aria-pressed:bg-hover-2', index === effortIndex && 'rounded-r-lg')}>
            {index === effortIndex
              ? <span className="size-full rounded-lg border bg-card shadow-sm" aria-hidden="true" />
              : <span className={cn('h-4 w-0.75 rounded-xs', index < effortIndex ? 'bg-ink-2' : 'bg-border')} aria-hidden="true" />}
          </ToggleGroupItem>)}
        </ToggleGroup>
      </> : <span className="text-xs text-muted-foreground">{models.length ? t('noEffortLevels') : t('effortNeedsModel')}</span>}
    </div>
  </SettingsSection>
}
