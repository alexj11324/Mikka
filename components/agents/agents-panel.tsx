'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Bot, ChevronRight, Cpu, Monitor, Plus, Sparkles } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { listAgents, listDevices, type AgentView, type DeviceView } from '@/app/actions/agents'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/reui/badge'
import { IconTile } from '@/components/reui/icon-tile'
import { isBuiltInAgentRole } from '@/lib/agent-roles'
import { cn } from '@/lib/utils'
import { AgentEditor, HARNESS_LABELS } from './agent-editor'
import { ROLE_ICONS } from './role-icons'

function usePlacementSummary() {
  const t = useTranslations('Agents')
  return (agent: AgentView) => {
    if (!agent.deviceId && !agent.harness && !agent.model) return t('allAuto')
    return [
      agent.deviceId ? agent.deviceName ?? t('deviceMissing') : t('autoDevice'),
      agent.harness ? HARNESS_LABELS[agent.harness] : t('autoHarness'),
      agent.model ?? t('autoModel'),
    ].join(' · ')
  }
}

function MetricCard({ icon: Icon, label, value, detail }: {
  icon: typeof Bot
  label: string
  value: string | number
  detail: string
}) {
  return (
    <Card size="sm" className="border-border/70 shadow-none">
      <CardHeader className="flex-row items-center gap-2 pb-0">
        <IconTile size="sm" variant="soft" className="text-project-action" aria-hidden="true"><Icon /></IconTile>
        <CardTitle className="line-clamp-2 text-xs leading-4 font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent className="flex items-baseline justify-between gap-2">
        <span className="text-xl font-semibold tracking-tight tabular-nums">{value}</span>
        <span className="hidden truncate text-xs text-muted-foreground sm:inline">{detail}</span>
      </CardContent>
    </Card>
  )
}

function RoleItem({ agent, selected, onSelect }: { agent: AgentView; selected: boolean; onSelect: () => void }) {
  const t = useTranslations('Agents')
  const summary = usePlacementSummary()
  const Icon = ROLE_ICONS[agent.role]
  const description = agent.description || (isBuiltInAgentRole(agent.role) ? t(`roleSummary.${agent.role}`) : t('customHint'))

  return (
    <Button
      type="button"
      variant="ghost"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'group h-auto w-full justify-start gap-3 whitespace-normal rounded-xl border px-3 py-3 text-left transition-colors focus-visible:ring-offset-2',
        selected
          ? 'border-project-action/25 bg-project-action/5 shadow-sm hover:bg-project-action/5'
          : 'border-transparent hover:border-border/70 hover:bg-muted/50',
      )}
    >
      <IconTile size="sm" variant={selected ? 'soft' : 'outline'} className={cn(selected ? 'text-project-action' : 'text-muted-foreground')} aria-hidden="true"><Icon data-icon="inline-start" /></IconTile>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold">{agent.name}</span>
          <Badge variant={selected ? 'primary-light' : 'secondary'} size="xs">{t(`roles.${agent.role}`)}</Badge>
          <ChevronRight data-icon="inline-end" className={cn('ml-auto size-4 shrink-0 text-muted-foreground transition-opacity', selected && 'opacity-100', !selected && 'opacity-0 group-hover:opacity-100')} aria-hidden="true" />
        </span>
        <span className="line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground">{description}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Cpu data-icon="inline-start" className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{summary(agent)}</span>
        </span>
      </span>
    </Button>
  )
}

function RoleGroupHeading({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center justify-between px-1 pb-2 pt-1">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      <span className="text-xs tabular-nums text-muted-foreground">{String(count).padStart(2, '0')}</span>
    </div>
  )
}

export function AgentsPanel() {
  const t = useTranslations('Agents')
  const { data: agents, mutate, error } = useSWR('agents', listAgents)
  const { data: deviceData } = useSWR<DeviceView[]>('devices', listDevices)
  const devices = deviceData ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const builtIn = agents?.filter(agent => isBuiltInAgentRole(agent.role)) ?? []
  const custom = agents?.filter(agent => !isBuiltInAgentRole(agent.role)) ?? []
  const selected = selectedId === 'new' ? null : agents?.find(agent => agent.id === selectedId) ?? agents?.[0] ?? null
  const creating = selectedId === 'new'
  const onlineDevices = devices.filter(device => device.online).length

  return (
    <section aria-label={t('title')} className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-4 py-6 md:px-6 md:py-8 xl:px-8">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex max-w-2xl flex-col gap-2">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-project-action">
            <span className="size-1.5 rounded-full bg-project-action" aria-hidden="true" />
            {t('eyebrow')}
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{t('title')}</h1>
            <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{t('description')}</p>
          </div>
        </div>
        <Button
          className="shrink-0 rounded-full bg-workspace-accent text-workspace-accent-foreground shadow-sm hover:bg-workspace-accent/90"
          disabled={!agents}
          onClick={() => setSelectedId('new')}
        >
          <Plus data-icon="inline-start" />
          {t('createTrigger')}
        </Button>
      </header>

      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <MetricCard icon={Bot} label={t('rolesMetric')} value={agents?.length ?? '—'} detail={t('rolesMetricHint')} />
        <MetricCard icon={Sparkles} label={t('builtInGroup')} value={builtIn.length || '—'} detail={t('builtInMetricHint')} />
        <MetricCard icon={Monitor} label={t('machinesMetric')} value={deviceData ? `${onlineDevices}/${devices.length}` : '—'} detail={t('machinesMetricHint', { online: onlineDevices, total: devices.length })} />
      </div>

      {error && <p role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{t('listError')}</p>}

      <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)] xl:grid-cols-[19rem_minmax(0,1fr)]">
        <Card className="min-w-0 border-border/70 shadow-none">
          <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
            <CardTitle className="text-sm">{t('listLabel')}</CardTitle>
            <Badge variant="secondary" size="sm">{agents?.length ?? '—'}</Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <section aria-label={t('builtInGroup')}>
              <RoleGroupHeading title={t('builtInGroup')} count={builtIn.length} />
              {!agents ? (
                <div className="flex flex-col gap-2">{[0, 1, 2].map(index => <Skeleton key={index} className="h-[6.5rem] rounded-xl" />)}</div>
              ) : (
                <div className="flex flex-col gap-1">
                  {builtIn.map(agent => (
                    <RoleItem key={agent.id} agent={agent} selected={!creating && selected?.id === agent.id} onSelect={() => setSelectedId(agent.id)} />
                  ))}
                </div>
              )}
            </section>

            <section aria-label={t('customGroup')}>
              <RoleGroupHeading title={t('customGroup')} count={custom.length} />
              {!agents ? (
                <Skeleton className="h-16 rounded-xl" />
              ) : custom.length === 0 && !creating ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setSelectedId('new')}
                  className="h-auto w-full justify-start gap-3 rounded-xl border border-dashed px-3 py-3 text-left whitespace-normal hover:border-project-action/30 hover:bg-project-action/5"
                >
                  <IconTile size="sm" variant="outline" className="text-project-action" aria-hidden="true"><Plus data-icon="inline-start" /></IconTile>
                  <span className="flex min-w-0 flex-col items-start gap-0.5">
                    <span className="text-sm font-medium">{t('customEmpty')}</span>
                    <span className="text-xs text-muted-foreground">{t('customEmptyHint')}</span>
                  </span>
                </Button>
              ) : (
                <div className="flex flex-col gap-1">
                  {custom.map(agent => (
                    <RoleItem key={agent.id} agent={agent} selected={!creating && selected?.id === agent.id} onSelect={() => setSelectedId(agent.id)} />
                  ))}
                  {creating && (
                    <div className="flex items-start gap-3 rounded-xl border border-project-action/25 bg-project-action/5 px-3 py-3" aria-current="true">
                      <IconTile size="sm" variant="soft" className="text-project-action" aria-hidden="true"><Plus /></IconTile>
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="text-sm font-semibold">{t('createTitle')}</span>
                        <span className="text-xs text-muted-foreground">{t('notSaved')}</span>
                      </span>
                    </div>
                  )}
                </div>
              )}
            </section>

            {deviceData && devices.length === 0 && (
              <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-xs leading-5 text-muted-foreground">{t('noDevicesHint')}</p>
            )}
          </CardContent>
        </Card>

        {agents && (creating || selected) ? (
          <AgentEditor
            key={creating ? 'new' : selected?.id}
            agent={creating ? null : selected}
            devices={devices}
            onSaved={id => { setSelectedId(id || null); void mutate() }}
            onDeleted={() => { setSelectedId(null); void mutate() }}
            onCancelNew={() => setSelectedId(null)}
          />
        ) : (
          <Skeleton className="h-[42rem] rounded-2xl" />
        )}
      </div>
    </section>
  )
}
