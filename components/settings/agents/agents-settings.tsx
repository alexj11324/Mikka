'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { ChevronLeft, ChevronRight, Laptop, Pencil, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Skeleton } from '@/components/ui/skeleton'
import { SettingsSection } from '@/components/settings/primitives'
import { createAgent, listAgents, listDevices, type AgentView, type DeviceView } from '@/app/actions/agents'
import { AGENT_TEMPLATE_IDS, AGENT_TEMPLATES, isBuiltInAgentRole, type AgentTemplateId } from '@/lib/agent-roles'
import { useActionError } from '@/lib/use-action-error'
import { cn } from '@/lib/utils'
import { AgentEditor, draftOf, type AgentDraft } from './agent-editor'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentAvatar, AgentGlyph, AgentStatusBadge, HarnessIcon } from './agent-parts'
import { modelSummary, reportedModels } from './runtime-fields'

type View = { kind: 'list' } | { kind: 'agent'; id: string } | { kind: 'new' } | { kind: 'custom' }

const ACCENT_BUTTON = 'rounded-full bg-agent-accent px-4 text-agent-accent-foreground hover:bg-agent-accent/90'

/** A new custom role's machine: the first enabled device that is online, else the first enabled one. */
function defaultDeviceId(devices: DeviceView[]): string | null {
  const enabled = devices.filter(device => device.enabled)
  return (enabled.find(device => device.online) ?? enabled[0])?.id ?? null
}

/**
 * Settings › Agent. A list of roles (built-in first, then custom), each
 * opening one detail page; 新建 Agent leads to a blank custom role or a preset.
 */
export function AgentsSettings() {
  const t = useTranslations('Agents')
  const { data: agents, mutate, error } = useSWR('agents', listAgents, { refreshInterval: 10_000 })
  const { data: devices = [] } = useSWR('devices', listDevices, { refreshInterval: 10_000 })
  const [view, setView] = useState<View>({ kind: 'list' })
  const toList = () => setView({ kind: 'list' })

  if (view.kind === 'agent') {
    const agent = agents?.find(item => item.id === view.id)
    if (agent) return <AgentEditor key={agent.id} agent={agent} initial={draftOf(agent)} devices={devices} onBack={toList} onSaved={() => mutate()} onCreated={toList} onDeleted={() => { void mutate(); toList() }} />
  }
  if (view.kind === 'custom') {
    const initial: AgentDraft = { role: 'custom', name: '', description: '', instructions: '', deviceId: defaultDeviceId(devices), harness: null, model: null, effort: null, permissionMode: null, icon: null, color: null }
    return <AgentEditor initial={initial} devices={devices} onBack={() => setView({ kind: 'new' })} onSaved={() => mutate()}
      onCreated={id => { void mutate().then(() => setView({ kind: 'agent', id })) }} onDeleted={toList} />
  }
  if (view.kind === 'new') {
    return <AgentPresets devices={devices} onBack={toList} onCustom={() => setView({ kind: 'custom' })}
      onCreated={id => { void mutate().then(() => setView({ kind: 'agent', id })) }} />
  }

  const builtIn = agents?.filter(agent => isBuiltInAgentRole(agent.role)) ?? []
  const custom = agents?.filter(agent => !isBuiltInAgentRole(agent.role)) ?? []
  return <div className="flex flex-col gap-8">
    <div className="flex justify-end">
      <Button onClick={() => setView({ kind: 'new' })}><Plus data-icon="inline-start" />{t('actions.new')}</Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{t('loadFailed')}</p>}
    <SettingsSection id="agents-default" title={t('groups.default')}>
      {agents ? builtIn.map(agent => <AgentRow key={agent.id} agent={agent} devices={devices} onOpen={() => setView({ kind: 'agent', id: agent.id })} />)
        : [0, 1, 2].map(index => <div key={index} className="flex items-center gap-3 px-4 py-3.5"><Skeleton className="size-9 rounded-full" /><Skeleton className="h-4 w-48" /></div>)}
    </SettingsSection>
    <SettingsSection id="agents-custom" title={t('groups.custom')}>
      {custom.map(agent => <AgentRow key={agent.id} agent={agent} devices={devices} onOpen={() => setView({ kind: 'agent', id: agent.id })} />)}
      <Button variant="ghost" className="h-auto w-full justify-start gap-3 rounded-none px-4 py-3 font-normal text-muted-foreground" onClick={() => setView({ kind: 'new' })}>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-dashed"><Plus data-icon="inline-start" /></span>
        {t('addCustom')}
      </Button>
    </SettingsSection>
  </div>
}

function AgentRow({ agent, devices, onOpen }: { agent: AgentView; devices: DeviceView[]; onOpen: () => void }) {
  const t = useTranslations('Agents')
  const summary = agent.description || (isBuiltInAgentRole(agent.role) ? t(`roles.${agent.role}.summary`) : '')
  const models = reportedModels(devices, agent.deviceId, agent.harness)
  const deviceName = agent.deviceName ?? t('runtime.noDevice')
  // The device tooltip opens on hover over the name, and also while the row has keyboard focus.
  const [hovered, setHovered] = useState(false)
  const [keyboardFocus, setKeyboardFocus] = useState(false)
  return <Button variant="ghost" className="h-auto w-full justify-start gap-3 rounded-none px-4 py-3.5 text-left font-normal whitespace-normal" onClick={onOpen}
    onFocus={event => setKeyboardFocus(event.currentTarget.matches(':focus-visible'))} onBlur={() => setKeyboardFocus(false)}>
    <AgentAvatar role={agent.role} name={agent.name} icon={agent.icon} color={agent.color} />
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex items-center gap-2"><span className="truncate font-medium">{agent.name}</span><AgentStatusBadge status={agent.status} /></span>
      {summary && <span className="truncate text-muted-foreground">{summary}</span>}
      {/* The device column is hidden on narrow screens; its name stays in the row's accessible name. */}
      <span className="sr-only sm:hidden">{deviceName}</span>
    </span>
    <span className="hidden w-36 shrink-0 items-center gap-1.5 truncate text-xs text-muted-foreground sm:flex">
      {agent.harness && <HarnessIcon harness={agent.harness} />}
      <span className="truncate">{agent.harness ? modelSummary(models, agent, t('runtime.defaultModel')) : t('runtime.noHarness')}</span>
    </span>
    <span className="hidden w-20 shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
      <Laptop data-icon="inline-start" className="size-3.5" />
      {/* The full name when the column cuts it short. */}
      <Tooltip open={hovered || keyboardFocus} onOpenChange={setHovered}><TooltipTrigger render={<span className="truncate" />}>{deviceName}</TooltipTrigger><TooltipContent>{deviceName}</TooltipContent></Tooltip>
    </span>
    <ChevronRight data-icon="inline-end" className="text-muted-foreground" />
  </Button>
}

/** 新建 Agent: write a custom role from scratch, or start from a preset whose prompt is already written. */
function AgentPresets({ devices, onBack, onCustom, onCreated }: { devices: DeviceView[]; onBack: () => void; onCustom: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations('Agents')
  const translateError = useActionError()
  const [template, setTemplate] = useState<AgentTemplateId>('tester')
  const [name, setName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const shownName = name ?? t(`templates.${template}.name`)

  const create = async () => {
    setBusy(true)
    setError('')
    const result = await createAgent({
      name: shownName.trim(), description: t(`templates.${template}.summary`), instructions: AGENT_TEMPLATES[template].instructions,
      icon: null, color: null, deviceId: defaultDeviceId(devices), harness: null, model: null, effort: null, permissionMode: null,
    })
    setBusy(false)
    if ('error' in result) { setError(translateError(result.error)); return }
    onCreated(result.id)
  }

  return <div className="flex flex-col gap-6">
    <Button variant="link" size="sm" className="self-start px-0 text-muted-foreground" onClick={onBack}><ChevronLeft data-icon="inline-start" />Agent</Button>
    <header className="flex flex-col gap-1">
      <h1 className="text-2xl font-medium tracking-tight">{t('new.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('new.description')}</p>
    </header>
    <Button variant="outline" className="h-auto w-full justify-start gap-3 rounded-xl p-4 text-left font-normal whitespace-normal" onClick={onCustom}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-agent-accent/10 text-agent-accent"><Pencil data-icon="inline-start" /></span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">{t('new.custom')}</span>
        <span className="text-xs text-muted-foreground">{t('new.customDescription')}</span>
      </span>
      <ChevronRight data-icon="inline-end" className="text-muted-foreground" />
    </Button>
    <h2 className="px-1 text-sm font-medium">{t('new.fromPreset')}</h2>
    <RadioGroup aria-label={t('new.fromPreset')} value={template} onValueChange={value => { setTemplate(value as AgentTemplateId); setName(null) }} className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3">
      {AGENT_TEMPLATE_IDS.map(id => <Label key={id} htmlFor={`preset-${id}`} className={cn('flex cursor-pointer flex-col items-start gap-1.5 rounded-xl border p-4 font-normal', template === id && 'border-agent-accent ring-1 ring-agent-accent')}>
        <span className="flex w-full items-start justify-between">
          <span className="flex size-8 items-center justify-center rounded-full bg-agent-accent/10 text-agent-accent [&_svg]:size-4"><AgentGlyph role="custom" icon={AGENT_TEMPLATES[id].icon} /></span>
          <RadioGroupItem id={`preset-${id}`} value={id} />
        </span>
        <span className="text-sm font-medium">{t(`templates.${id}.name`)}</span>
        <span className="text-xs leading-relaxed text-muted-foreground">{t(`templates.${id}.summary`)}</span>
      </Label>)}
    </RadioGroup>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap items-end gap-3 border-t pt-4">
      <FieldGroup className="flex-1 basis-64">
        <Field>
          <FieldLabel htmlFor="preset-name">{t('fields.name')}</FieldLabel>
          <Input id="preset-name" className="h-9" value={shownName} maxLength={60} onChange={event => setName(event.target.value)} />
        </Field>
      </FieldGroup>
      <div className="flex gap-2">
        <Button variant="outline" size="lg" className="rounded-full px-4" onClick={onBack}>{t('actions.cancel')}</Button>
        <Button size="lg" className={ACCENT_BUTTON} disabled={busy || !shownName.trim()} onClick={() => void create()}>{t('actions.create')}</Button>
      </div>
    </div>
  </div>
}
