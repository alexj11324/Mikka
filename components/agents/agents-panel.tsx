'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/reui/badge'
import { Frame, FrameHeader, FramePanel, FrameTitle } from '@/components/reui/frame'
import { IconTile } from '@/components/reui/icon-tile'
import { listAgents, listDevices, type AgentView, type DeviceView } from '@/app/actions/agents'
import { isBuiltInAgentRole } from '@/lib/agent-roles'
import { cn } from '@/lib/utils'
import { AgentEditor, HARNESS_LABELS } from './agent-editor'
import { ROLE_ICONS } from './role-icons'

/** "MacBook Pro · Claude Code · opus", or one word when everything is auto. */
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

function RoleItem({ agent, selected, onSelect }: { agent: AgentView; selected: boolean; onSelect: () => void }) {
  const t = useTranslations('Agents')
  const summary = usePlacementSummary()
  const Icon = ROLE_ICONS[agent.role]
  return (
    <Item
      size="sm"
      variant={selected ? 'muted' : 'default'}
      className={cn('cursor-pointer text-left', !selected && 'hover:bg-muted/40')}
      aria-current={selected ? 'true' : undefined}
      render={<button type="button" onClick={onSelect} />}
    >
      <ItemMedia>
        <IconTile size="sm" variant={selected ? 'elevated' : 'outline'} aria-hidden="true"><Icon /></IconTile>
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full">
          <span className="truncate">{agent.name}</span>
          {isBuiltInAgentRole(agent.role) && <Badge variant="secondary" size="xs">{t(`roles.${agent.role}`)}</Badge>}
        </ItemTitle>
        <ItemDescription className="truncate text-xs">{summary(agent)}</ItemDescription>
      </ItemContent>
    </Item>
  )
}

/**
 * The Agent section: roles on the left, the selected one edited in place on
 * the right. Coordinator, Worker and Reviewer are created for every person on
 * first load (see `listAgents`); custom roles are added with New role.
 */
export function AgentsPanel() {
  const t = useTranslations('Agents')
  const { data: agents, mutate, error } = useSWR('agents', listAgents)
  const { data: devices = [] } = useSWR<DeviceView[]>('devices', listDevices)
  /** An agent id, 'new' for an unsaved custom role, or null for the first role. */
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const builtIn = agents?.filter(agent => isBuiltInAgentRole(agent.role)) ?? []
  const custom = agents?.filter(agent => !isBuiltInAgentRole(agent.role)) ?? []
  const selected = selectedId === 'new' ? null : agents?.find(agent => agent.id === selectedId) ?? agents?.[0] ?? null
  const creating = selectedId === 'new'

  return (
    <section aria-label={t('title')} className="flex w-full flex-col gap-6 px-5 py-6 md:px-10 lg:px-14 lg:py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex max-w-2xl flex-col gap-1.5">
          <h1 className="text-2xl font-medium tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <Button
          className="rounded-full bg-workspace-accent text-workspace-accent-foreground hover:bg-workspace-accent/90"
          disabled={!agents}
          onClick={() => setSelectedId('new')}
        >
          <Plus data-icon="inline-start" />
          {t('createTrigger')}
        </Button>
      </header>

      {error && <p role="alert" className="text-xs text-destructive">{t('listError')}</p>}

      <div className="grid items-start gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <Frame spacing="sm" aria-label={t('listLabel')}>
          <FrameHeader><FrameTitle className="text-xs text-muted-foreground">{t('builtInGroup')}</FrameTitle></FrameHeader>
          <FramePanel fit className="p-1">
            {!agents ? (
              <div className="flex flex-col gap-1 p-1">{[0, 1, 2].map(index => <Skeleton key={index} className="h-12 rounded-lg" />)}</div>
            ) : (
              <ItemGroup className="gap-0.5">
                {builtIn.map(agent => (
                  <RoleItem key={agent.id} agent={agent} selected={!creating && selected?.id === agent.id} onSelect={() => setSelectedId(agent.id)} />
                ))}
              </ItemGroup>
            )}
          </FramePanel>
          <FrameHeader><FrameTitle className="text-xs text-muted-foreground">{t('customGroup')}</FrameTitle></FrameHeader>
          <FramePanel fit className="p-1">
            {custom.length === 0 && !creating ? (
              <Button variant="ghost" size="sm" className="w-full justify-start text-muted-foreground" disabled={!agents} onClick={() => setSelectedId('new')}>
                <Plus data-icon="inline-start" />
                {t('customEmpty')}
              </Button>
            ) : (
              <ItemGroup className="gap-0.5">
                {custom.map(agent => (
                  <RoleItem key={agent.id} agent={agent} selected={!creating && selected?.id === agent.id} onSelect={() => setSelectedId(agent.id)} />
                ))}
                {creating && (
                  <Item size="sm" variant="muted">
                    <ItemMedia><IconTile size="sm" variant="elevated" aria-hidden="true"><Plus /></IconTile></ItemMedia>
                    <ItemContent><ItemTitle>{t('createTitle')}</ItemTitle><ItemDescription className="text-xs">{t('notSaved')}</ItemDescription></ItemContent>
                  </Item>
                )}
              </ItemGroup>
            )}
          </FramePanel>
          {devices.length === 0 && agents && (
            <p className="px-2 pb-1 text-xs text-muted-foreground">{t('noDevicesHint')}</p>
          )}
        </Frame>

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
          <Skeleton className="h-[32rem] rounded-xl" />
        )}
      </div>
    </section>
  )
}
