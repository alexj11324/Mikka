'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Bot, Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { listAgents, listDevices, type DeviceView } from '@/app/actions/agents'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { isBuiltInAgentRole } from '@/lib/agent-roles'
import { AgentEditor } from './agent-editor'

export function AgentsPanel() {
  const t = useTranslations('Agents')
  const commonT = useTranslations('Common')
  const { data: agents, mutate, error, isValidating } = useSWR('agents', listAgents)
  const { data: deviceData } = useSWR<DeviceView[]>('devices', listDevices)
  const devices = deviceData ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const creating = selectedId === 'new'
  const selected = creating ? null : agents?.find(agent => agent.id === selectedId) ?? agents?.[0] ?? null
  const builtIn = agents?.filter(agent => isBuiltInAgentRole(agent.role)) ?? []
  const custom = agents?.filter(agent => !isBuiltInAgentRole(agent.role)) ?? []
  const roleItems = [
    ...builtIn.map(agent => ({ value: agent.id, label: agent.name })),
    ...custom.map(agent => ({ value: agent.id, label: agent.name })),
    ...(creating ? [{ value: 'new', label: t('createTitle') }] : []),
  ]

  if (error) {
    return (
      <section aria-label={t('title')} className="flex w-full flex-col gap-4">
        <Empty className="min-h-80 rounded-xl border border-border/70">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Bot aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>{t('listError')}</EmptyTitle>
            <EmptyDescription>{t('listErrorDescription')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" disabled={isValidating} onClick={() => { void mutate().catch(() => {}) }}>{commonT('retry')}</Button>
          </EmptyContent>
        </Empty>
      </section>
    )
  }

  if (!agents) {
    return (
      <section aria-label={t('title')} className="flex w-full flex-col gap-4">
        <Empty className="min-h-64 rounded-xl border border-border/70">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Bot aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>{t('loadingRoles')}</EmptyTitle>
            <EmptyDescription>{t('loadingDescription')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => { void mutate().catch(() => {}) }}>{commonT('retry')}</Button>
          </EmptyContent>
        </Empty>
      </section>
    )
  }

  if (agents.length === 0 && !creating) {
    return (
      <section aria-label={t('title')} className="flex w-full flex-col gap-4">
        <Empty className="min-h-80 rounded-xl border border-border/70">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Bot aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>{t('emptyTitle')}</EmptyTitle>
            <EmptyDescription>{t('emptyDescription')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={() => setSelectedId('new')}>
              <Plus data-icon="inline-start" />
              {t('createTrigger')}
            </Button>
          </EmptyContent>
        </Empty>
      </section>
    )
  }

  return (
    <section aria-label={t('title')} className="flex w-full flex-col gap-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <FieldGroup className="min-w-0 flex-1 sm:max-w-xl">
          <Field orientation="responsive" className="justify-between gap-3">
            <FieldLabel htmlFor="agent-role-selector" className="@md/field-group:flex-none">{t('roleSelector')}</FieldLabel>
            <div className="min-w-0 @md/field-group:flex-[0_1_24rem]">
              <Select value={creating ? 'new' : selected?.id ?? ''} items={roleItems} onValueChange={value => setSelectedId(value === 'new' ? 'new' : value)}>
                <SelectTrigger id="agent-role-selector" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {builtIn.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>{t('builtInGroup')}</SelectLabel>
                      {builtIn.map(agent => <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>)}
                    </SelectGroup>
                  )}
                  {custom.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>{t('customGroup')}</SelectLabel>
                      {custom.map(agent => <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>)}
                    </SelectGroup>
                  )}
                  {creating && (
                    <SelectGroup>
                      <SelectLabel>{t('customGroup')}</SelectLabel>
                      <SelectItem value="new">{t('createTitle')}</SelectItem>
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>
            </div>
          </Field>
        </FieldGroup>
        <Button size="sm" onClick={() => setSelectedId('new')}>
          <Plus data-icon="inline-start" />
          {t('createTrigger')}
        </Button>
      </div>

      {creating || selected ? (
        <AgentEditor
          key={creating ? 'new' : selected?.id}
          agent={creating ? null : selected}
          devices={devices}
          onSaved={id => { setSelectedId(id || null); void mutate() }}
          onDeleted={() => { setSelectedId(null); void mutate() }}
          onCancelNew={() => setSelectedId(null)}
        />
      ) : null}
    </section>
  )
}
