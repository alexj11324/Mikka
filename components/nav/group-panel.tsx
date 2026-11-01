'use client'

import { motion } from 'motion/react'
import { useTranslations } from 'next-intl'
import { X } from 'lucide-react'
import { InlineLoadError } from '@/components/load-error'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SPRING_SIDEBAR } from '@/lib/ease'
import type { GroupMember } from '@/lib/group-messages'
import { cn } from '@/lib/utils'
import { BotAvatar } from './bot-avatar'
import { GroupAvatar, useGroupMembers } from './group-avatar'
import { GroupHeader } from './group-header'
import { LetterAvatar } from './letter-avatar'

const WIDTH = 360

/** A member row: people with their letter, bots with their bloub (R-36), then the name. */
function MemberRow({ member }: { member: GroupMember }) {
  return <li className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-sm">
    {member.memberType === 'bot' ? <BotAvatar color={member.color} shape={member.shape} size="row" still /> : <LetterAvatar name={member.name} size="row" />}
    <span className="truncate">{member.name}</span>
  </li>
}

/**
 * A group chat's right column, read-only (R-13, R-51): the group's avatar and
 * name, then its members, people and bots. No computer: a group has none, a
 * bot's own chat shows its. Recent threads and files join once a group's
 * threads and files are stored with it.
 */
export function GroupPanel({ group, onClose, sheet = false }: { group: { id: string; title: string }; onClose: () => void; sheet?: boolean }) {
  const t = useTranslations('Shell.panel')
  const { data: members, error, mutate } = useGroupMembers(group.id)
  const label = members ? t('members', { count: members.length }) : t('membersLoading')
  return <motion.aside aria-label={t('label')} initial={sheet ? false : { width: 0 }} animate={sheet ? undefined : { width: WIDTH }} exit={sheet ? undefined : { width: 0 }} transition={SPRING_SIDEBAR}
    className={cn('relative min-h-0 shrink-0 flex-col', sheet ? 'flex size-full' : 'hidden overflow-hidden border-l bg-background xl:flex')}>
    <div className={cn('flex min-h-0 flex-1 flex-col', !sheet && 'min-w-90')}>
      <div className="flex h-11 shrink-0 items-center gap-1 px-3">
        <p className="flex h-7 items-center rounded-full bg-muted px-2.5 text-sm">{t('details')}</p>
        <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="ml-auto" aria-label={t('close')} onClick={onClose} />}><X data-icon="inline-start" /></TooltipTrigger><TooltipContent>{t('close')}</TooltipContent></Tooltip>
      </div>
      <div className="flex shrink-0 flex-col items-center gap-3 px-4 pt-9 pb-4">
        <GroupAvatar title={group.title} members={members} size="profile" />
        <h2 className="max-w-full truncate text-xl font-semibold">{group.title}</h2>
      </div>
      <section aria-label={label} className="flex min-h-0 flex-col gap-1 overflow-y-auto px-4 pb-4">
        <GroupHeader>{label}</GroupHeader>
        {error ? <div className="px-2 py-1.5"><InlineLoadError message={t('membersError')} retryLabel={t('retry')} onRetry={() => { void mutate() }} /></div>
          : !members ? <div aria-busy="true" className="flex flex-col gap-2 px-2 py-1.5">{[0, 1, 2].map(index => <Skeleton key={index} className="h-5 w-40" />)}</div>
          : <ul className="flex flex-col">{members.map(member => <MemberRow key={`${member.memberType}:${member.id}`} member={member} />)}</ul>}
      </section>
    </div>
  </motion.aside>
}
