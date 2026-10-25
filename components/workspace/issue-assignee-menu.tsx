'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { MetadataRequest } from './issue-metadata-controls'
import useSWR from 'swr'
import { Check, CircleUserRound, Send, UserRound } from 'lucide-react'
import { getIssuePropertyOptions } from '@/app/actions/issue-metadata'
import type { IssueMetadata } from '@/lib/issue-metadata'
import { Button } from '@/components/ui/button'
import { toneFor, type AvatarTone } from '@/components/nav/letter-avatar'
import { cn } from '@/lib/utils'
import { SPHERE_TONES } from '@/lib/status-appearance'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from '@/components/ui/command'


/** An agent's mark: a gradient sphere with a soft highlight, tinted by name. */
export function AgentSphere({ name, compact = false }: { name: string; compact?: boolean }) {
  const tone: keyof typeof SPHERE_TONES = /coordinator/i.test(name) ? 'coordinator' : `t${toneFor(name) as Exclude<AvatarTone, 'coordinator'>}`
  return <span aria-hidden="true" className={cn('relative inline-flex shrink-0 overflow-hidden rounded-full bg-linear-135 shadow-inner', SPHERE_TONES[tone], compact && 'size-4.5', !compact && 'size-6')}>
    <span className="absolute top-[12%] left-[18%] size-[45%] rounded-full bg-avatar-foreground/70 blur-[2px]" />
  </span>
}

export function AssigneeAvatar({ assignee, compact = false }: { assignee: IssueMetadata['assignee']; compact?: boolean }) {
  if (!assignee) return <CircleUserRound data-icon="inline-start" />
  // Agents are glossy spheres (Figma 77:2), people are photos or initials.
  if (assignee.kind === 'agent') return <AgentSphere name={assignee.name} compact={compact} />
  return <Avatar size={compact ? 'xs' : 'sm'}><AvatarImage src={assignee.image ?? undefined} alt="" draggable={false} /><AvatarFallback>{assignee.name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
}

export function IssueAssigneeMenu({ id, assignee, disabled, compact, onChange, onInvite, request }: {
  id: string; assignee: IssueMetadata['assignee']; disabled?: boolean; compact?: boolean
  onChange: (value: { kind: 'member' | 'agent'; id: string } | null) => Promise<boolean>
  onInvite: () => void; request?: MetadataRequest | null
}) {
  const t = useTranslations('Metadata.assignee')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  useEffect(() => { if (request?.target === 'assignee') { setOpen(true); setQuery('') } }, [request])
  const { data, error, mutate } = useSWR(open ? ['issue-property-options', id] : null, () => getIssuePropertyOptions(id))
  async function select(value: { kind: 'member' | 'agent'; id: string } | null) {
    if (await onChange(value)) { setOpen(false); setQuery('') }
  }
  return <Popover open={open} onOpenChange={value => { setOpen(value); setQuery('') }}>
    <PopoverTrigger render={<Button data-assignee-trigger type="button" variant="ghost" size={compact ? 'icon-compact' : 'sm'} disabled={disabled} aria-label={t('aria', { name: assignee?.name ?? t('unassigned') })} title={t('ariaShortcut', { name: assignee?.name ?? t('unassigned') })} />}>
      <AssigneeAvatar assignee={assignee} compact={compact} />{!compact && (assignee?.name ?? t('unassignedLabel'))}
    </PopoverTrigger>
    <PopoverContent align="end" className="w-72 p-0">
      <Command onKeyDownCapture={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || query || disabled) return
        const index = Number(event.key)
        if (/^[0-9]$/.test(event.key) && (index === 0 || data?.members[index - 1])) {
          event.preventDefault(); event.stopPropagation()
          void select(index === 0 ? null : { kind: 'member', id: data!.members[index - 1].id })
        }
      }}>
        <CommandInput placeholder={t('assignPlaceholder')} aria-label={t('searchAria')} value={query} onValueChange={setQuery} />
        <CommandList>
          <CommandEmpty>{error ? t('readFailed') : data ? t('noMatch') : t('loading')}</CommandEmpty>
          <CommandGroup heading={t('group')}>
            <CommandItem value={t('unassignedLabel')} disabled={disabled} onSelect={() => { void select(null) }}><CircleUserRound /><span className="flex-1">{t('unassigned')}</span>{!assignee && <Check />}<CommandShortcut>0</CommandShortcut></CommandItem>
            {data?.members.map((member, index) => <CommandItem key={member.id} value={`${member.name} ${member.id}`} disabled={disabled} onSelect={() => { void select({ kind: 'member', id: member.id }) }}><AssigneeAvatar assignee={{ ...member, kind: 'member' }} /><span className="flex-1 truncate">{member.name}</span>{assignee?.kind === 'member' && assignee.id === member.id && <Check />}{index < 9 && <CommandShortcut>{index + 1}</CommandShortcut>}</CommandItem>)}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading={t('agents')}>
            {data?.agents.map(agent => <CommandItem key={agent.id} value={`${agent.name} ${agent.harness}`} disabled={disabled} onSelect={() => { void select({ kind: 'agent', id: agent.id }) }}><AgentSphere name={agent.name} compact /><span className="flex-1 truncate">{agent.name}</span>{assignee?.kind === 'agent' && assignee.id === agent.id && <Check />}</CommandItem>)}
            {data && !data.agents.length && <p className="px-2 py-3 text-xs text-muted-foreground">{t('noAgents')}</p>}
          </CommandGroup>
          {data?.isOwner && <><CommandSeparator /><CommandGroup heading={t('newMember')}><CommandItem value={t('invite')} onSelect={() => { setOpen(false); onInvite() }}><Send />{t('invite')}</CommandItem></CommandGroup></>}
          {error && <CommandGroup><CommandItem onSelect={() => { void mutate() }}><UserRound />{t('reload')}</CommandItem></CommandGroup>}
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
}
