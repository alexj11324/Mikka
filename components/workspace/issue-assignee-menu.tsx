'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Bot, Check, CircleUserRound, Send, UserRound } from 'lucide-react'
import { getIssuePropertyOptions } from '@/app/actions/issue-metadata'
import type { IssueMetadata } from '@/lib/issue-metadata'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from '@/components/ui/command'

export function AssigneeAvatar({ assignee, compact = false }: { assignee: IssueMetadata['assignee']; compact?: boolean }) {
  if (!assignee) return <CircleUserRound data-icon="inline-start" />
  if (assignee.kind === 'agent') return <Bot data-icon="inline-start" />
  return <Avatar size={compact ? 'xs' : 'sm'}><AvatarImage src={assignee.image ?? undefined} alt="" draggable={false} /><AvatarFallback>{assignee.name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
}

export function IssueAssigneeMenu({ id, assignee, disabled, compact, onChange, onInvite }: {
  id: string; assignee: IssueMetadata['assignee']; disabled?: boolean; compact?: boolean
  onChange: (value: { kind: 'member' | 'agent'; id: string } | null) => Promise<boolean>
  onInvite: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const { data, error, mutate } = useSWR(open ? ['issue-property-options', id] : null, () => getIssuePropertyOptions(id))
  async function select(value: { kind: 'member' | 'agent'; id: string } | null) {
    if (await onChange(value)) { setOpen(false); setQuery('') }
  }
  return <Popover open={open} onOpenChange={value => { setOpen(value); setQuery('') }}>
    <PopoverTrigger render={<Button data-assignee-trigger type="button" variant="ghost" size={compact ? 'icon-compact' : 'sm'} disabled={disabled} aria-label={`负责人：${assignee?.name ?? '未分配'}`} title={`负责人：${assignee?.name ?? '未分配'} · A`} />}>
      <AssigneeAvatar assignee={assignee} compact={compact} />{!compact && (assignee?.name ?? '未分配负责人')}
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
        <CommandInput placeholder="分配给…" aria-label="搜索负责人" value={query} onValueChange={setQuery} />
        <CommandList>
          <CommandEmpty>{error ? '成员读取失败，请重试' : data ? '没有匹配的负责人' : '正在读取成员…'}</CommandEmpty>
          <CommandGroup heading="负责人">
            <CommandItem value="未分配负责人" disabled={disabled} onSelect={() => { void select(null) }}><CircleUserRound /><span className="flex-1">未分配</span>{!assignee && <Check />}<CommandShortcut>0</CommandShortcut></CommandItem>
            {data?.members.map((member, index) => <CommandItem key={member.id} value={`${member.name} ${member.id}`} disabled={disabled} onSelect={() => { void select({ kind: 'member', id: member.id }) }}><AssigneeAvatar assignee={{ ...member, kind: 'member' }} /><span className="flex-1 truncate">{member.name}</span>{assignee?.kind === 'member' && assignee.id === member.id && <Check />}{index < 9 && <CommandShortcut>{index + 1}</CommandShortcut>}</CommandItem>)}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Agents">
            {data?.agents.map(agent => <CommandItem key={agent.id} value={`${agent.name} ${agent.harness}`} disabled={disabled} onSelect={() => { void select({ kind: 'agent', id: agent.id }) }}><Bot /><span className="flex-1 truncate">{agent.name}</span>{assignee?.kind === 'agent' && assignee.id === agent.id && <Check />}</CommandItem>)}
            {data && !data.agents.length && <p className="px-2 py-3 text-xs text-muted-foreground">尚未配置 Agent</p>}
          </CommandGroup>
          {data?.isOwner && <><CommandSeparator /><CommandGroup heading="新成员"><CommandItem value="邀请并分配成员" onSelect={() => { setOpen(false); onInvite() }}><Send />邀请并分配…</CommandItem></CommandGroup></>}
          {error && <CommandGroup><CommandItem onSelect={() => { void mutate() }}><UserRound />重新读取成员</CommandItem></CommandGroup>}
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
}
