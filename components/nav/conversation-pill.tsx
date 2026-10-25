import type { ReactNode } from 'react'
import { LetterAvatar, type AvatarTone } from './letter-avatar'

/** The current chat as a centered, borderless pill floating over it (MIK-40, Figma 48:3): the bot's avatar and name. */
export function ConversationPill({ name, tone, avatar }: { name: string; tone?: AvatarTone; avatar?: ReactNode }) {
  return <div className="pointer-events-none absolute inset-x-0 top-3 z-10 hidden justify-center md:flex">
    <p data-slot="conversation-pill" className="pointer-events-auto flex h-9 max-w-[min(24rem,80%)] items-center gap-2 rounded-full bg-popover pr-4 pl-2 text-sm font-semibold text-popover-foreground shadow-md ring-1 ring-foreground/5">
      {avatar ?? <LetterAvatar name={name} tone={tone} size="pill" />}
      <span data-slot="conversation-pill-title" className="truncate">{name}</span>
    </p>
  </div>
}
