'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import { useViewScroll } from '@/lib/hooks/view-state'
import { useTranslations } from 'next-intl'
import { InlineLoadError } from '@/components/load-error'
import { Skeleton } from '@/components/ui/skeleton'
import { ResizeHandle } from '@/components/ui/resizable-pane'
import { PanelHeader } from '@ui-slot/panel-header'
import { useResizableWidth } from '@/hooks/use-resizable-width'
import { usePanelInitialWidth, useWidenToggle } from '@/hooks/use-panel-width'
import { leaveGroupConversation, mayLeaveGroup, type GroupMember } from '@/lib/group-messages'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { BotAvatar } from './bot-avatar'
import { GroupAvatar, memberAvatar, useGroupMembers } from './group-avatar'
import { GroupHeader } from './group-header'
import { LetterAvatar } from './letter-avatar'

// The same right column as a bot's 概览, so it shares that column's remembered width.
const WIDTH = { storageKey: 'mikka:context-panel-width', min: 320, max: 'half', initial: 360, edge: 'start' } as const

/** A member row: people with their letter, bots with their bloub (R-36), then the name. */
function MemberRow({ member }: { member: GroupMember }) {
  return <li className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-sm">
    {member.memberType === 'bot' ? <BotAvatar {...memberAvatar(member)} size="row" still /> : <LetterAvatar name={member.name} size="row" />}
    <span className="truncate">{member.name}</span>
  </li>
}

/**
 * A group chat's right column, read-only (R-13, R-51): the group's avatar and
 * name, then its members, people and bots. No computer: a group has none, a
 * bot's own chat shows its. Recent threads and files join once a group's
 * threads and files are stored with it.
 */
export function GroupPanel({ group, userId, onLeft, onClose, sheet = false }: { group: { id: string; title: string }; userId: string; onLeft: (groupId: string) => Promise<void>; onClose: () => void; sheet?: boolean }) {
  const t = useTranslations('Shell.panel')
  const tGroup = useTranslations('GroupChat')
  const [leaving, setLeaving] = useState(false)
  const leave = async () => {
    if (leaving || !window.confirm(tGroup('leaveConfirm'))) return
    setLeaving(true)
    try {
      await leaveGroupConversation(group.id, userId)
      await onLeft(group.id)
    } catch {
      toast.error(tGroup('leaveError'))
      setLeaving(false)
    }
  }
  const { data: members, error, mutate } = useGroupMembers(group.id)
  const scroll = useViewScroll<HTMLElement>(`group-panel:${group.id}`, !!members)
  const label = members ? t('members', { count: members.length }) : t('membersLoading')
  // A UI layer may size the default from the main area (panel-header slot); a remembered width still wins.
  const resize = useResizableWidth({ ...WIDTH, initial: usePanelInitialWidth(WIDTH.initial) })
  // ⤢ as 概览 has it; only a layer's header offers it, the default keeps 详情 · ✕.
  const widen = useWidenToggle(resize)
  const asideRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => { asideRef.current?.style.setProperty('--group-panel-width', `${resize.width}px`) }, [resize.width])
  const tCommon = useTranslations('Common')
  // R-37: opening and closing are instant, no motion (decision 2026-11-01-2320).
  return <aside ref={asideRef} aria-label={t('label')}
    className={cn('relative min-h-0 shrink-0 flex-col', sheet ? 'flex size-full' : 'hidden w-(--group-panel-width) overflow-hidden border-l bg-background xl:flex', resize.dragging && 'select-none')}>
    {!sheet && <ResizeHandle resize={resize} label={tCommon('resize.groupPanel')} edge="start" onDoubleClick={widen.reset} />}
    <div className={cn('flex min-h-0 flex-1 flex-col', !sheet && 'min-w-80')}>
      <PanelHeader variant="group" title={t('details')} actions={[]} onClose={onClose} widen={sheet ? undefined : { wide: widen.wide, onToggle: widen.onToggle }} />
      <div className="flex shrink-0 flex-col items-center gap-3 px-4 pt-9 pb-4">
        <GroupAvatar title={group.title} members={members} size="profile" />
        <h2 className="max-w-full truncate text-xl font-semibold">{group.title}</h2>
      </div>
      <section ref={scroll} aria-label={label} className="flex min-h-0 flex-col gap-1 overflow-y-auto px-4 pb-4">
        <GroupHeader>{label}</GroupHeader>
        {error ? <div className="px-2 py-1.5"><InlineLoadError message={t('membersError')} retryLabel={t('retry')} onRetry={() => { void mutate() }} /></div>
          : !members ? <div aria-busy="true" className="flex flex-col gap-2 px-2 py-1.5">{[0, 1, 2].map(index => <Skeleton key={index} className="h-5 w-40" />)}</div>
          : <ul className="flex flex-col">{members.map(member => <MemberRow key={`${member.memberType}:${member.id}`} member={member} />)}</ul>}
      </section>
      {mayLeaveGroup(members, userId) && <div className="shrink-0 px-4 pb-4">
        <Button variant="outline" size="sm" disabled={leaving} onClick={() => { void leave() }}>{tGroup('leave')}</Button>
      </div>}
    </div>
  </aside>
}
