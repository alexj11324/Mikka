'use client'

import useSWR from 'swr'
import { fetchGroupMembers, type GroupMember } from '@/lib/group-messages'
import { cn } from '@/lib/utils'
import { BotAvatar } from './bot-avatar'
import { LetterAvatar } from './letter-avatar'

/** The SWR key for a group's members, shared by the chat's pill and its 详情. */
export const groupMembersKey = (id: string) => ['group-members', id] as const

export function useGroupMembers(id: string) {
  return useSWR(groupMembersKey(id), ([, groupId]: readonly [string, string]) => fetchGroupMembers(groupId))
}

/** At most this many bloubs stand in the group's avatar. */
const STACKED = 3

/**
 * A group's avatar (R-36): its bots' bloubs side by side, overlapping, never
 * a letter taken from the title (「0.9.5 发版群」 used to read 「0」). A group
 * with no bot yet, or whose members are still loading, shows the title's letter.
 */
export function GroupAvatar({ title, members, size = 'pill' }: { title: string; members: readonly GroupMember[] | undefined; size?: 'pill' | 'profile' }) {
  const bots = (members ?? []).filter(member => member.memberType === 'bot').slice(0, STACKED)
  if (!bots.length) return <LetterAvatar name={title} size={size} />
  return <span aria-hidden="true" className={cn('flex shrink-0 items-center', size === 'pill' ? '-space-x-1.5' : '-space-x-4')}>
    {bots.map(bot => <BotAvatar key={bot.id} color={bot.color} shape={bot.shape} size={size === 'pill' ? 'row' : 'cell'} still />)}
  </span>
}

/** The avatar for a group's pill, loading its members by the shared key. */
export function GroupPillAvatar({ id, title }: { id: string; title: string }) {
  const { data: members } = useGroupMembers(id)
  return <GroupAvatar title={title} members={members} />
}
