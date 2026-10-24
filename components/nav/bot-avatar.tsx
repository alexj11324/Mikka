import { cn } from '@/lib/utils'

/** A stable sphere tint for a bot, so it keeps its color everywhere. */
function sphereFor(id: string) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) | 0
  return Math.abs(hash) % 3 + 1
}

/**
 * A bot (glossary: the thing a person talks to) as a lit sphere, Figma
 * 188:3115: 72px on its 详情, 32px in the list, 24px in the title pill, 16px
 * on a byline.
 */
export function BotAvatar({ id, size = 'list' }: { id: string; size?: 'profile' | 'list' | 'pill' | 'byline' }) {
  const sphere = sphereFor(id)
  return <span aria-hidden="true" className={cn('inline-block shrink-0 rounded-full', size === 'profile' && 'size-18', size === 'list' && 'size-8', size === 'pill' && 'size-6', size === 'byline' && 'size-4',
    sphere === 1 && 'bg-bot-sphere-1', sphere === 2 && 'bg-bot-sphere-2', sphere === 3 && 'bg-bot-sphere-3')} />
}
