import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { LetterAvatar, type AvatarTone } from './letter-avatar'

const PILL = 'flex h-9 items-center gap-2 rounded-full bg-popover pr-4 pl-2 text-sm font-semibold text-popover-foreground ring-1 ring-foreground/5'

/** The current chat as a centered, borderless pill floating over it (MIK-40, Figma 48:3): the bot's avatar and name. */
export function ConversationPill({ name, tone, avatar }: { name: string; tone?: AvatarTone; avatar?: ReactNode }) {
  return <div className="pointer-events-none absolute inset-x-0 top-3 z-10 hidden justify-center md:flex">
    <p data-slot="conversation-pill" className={cn(PILL, 'pointer-events-auto max-w-[min(24rem,80%)] shadow-md')}>
      {avatar ?? <LetterAvatar name={name} tone={tone} size="pill" />}
      <span data-slot="conversation-pill-title" className="truncate">{name}</span>
    </p>
  </div>
}

/**
 * The same pill in a phone's header, where it is a button: it opens the chat's
 * right column (概览, a group's 详情) as a page over the chat (R-82; decision
 * 2026-10-31-2345-mobile-bot-home). Desktop keeps the column's own toggle.
 */
export function ConversationPillButton({ name, avatar, onOpen }: { name: string; avatar: ReactNode; onOpen: () => void }) {
  return <Button variant="outline" data-slot="conversation-pill" aria-haspopup="dialog" onClick={onOpen} className="min-w-0 max-w-full justify-start gap-2 rounded-full pr-3 pl-1 font-semibold md:hidden">
    {avatar}
    <span data-slot="conversation-pill-title" className="truncate">{name}</span>
  </Button>
}
