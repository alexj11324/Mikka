import { cn } from '@/lib/utils'

/** A stable sphere tint for a bot, so it keeps its color everywhere. */
function sphereFor(id: string) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) | 0
  return Math.abs(hash) % 3 + 1
}

/**
 * A bot (glossary: the thing a person talks to) as a lit sphere, Figma
 * 188:3115: 32px in the list, 24px in the title pill, 16px on a byline.
 * A thread is never shown with it; threads use ThreadAvatar.
 */
export function BotAvatar({ id, size = 'list' }: { id: string; size?: 'list' | 'pill' | 'byline' }) {
  const sphere = sphereFor(id)
  return <span aria-hidden="true" className={cn('inline-block shrink-0 rounded-full', size === 'list' && 'size-8', size === 'pill' && 'size-6', size === 'byline' && 'size-4',
    sphere === 1 && 'bg-bot-sphere-1', sphere === 2 && 'bg-bot-sphere-2', sphere === 3 && 'bg-bot-sphere-3')} />
}

/** A thread (one run of a bot's work): "#" on orange, 72px on its 详情. */
export function ThreadAvatar() {
  return <span aria-hidden="true" className="flex size-18 shrink-0 items-center justify-center rounded-full bg-avatar-5 text-4xl font-semibold text-avatar-foreground">#</span>
}
