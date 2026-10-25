import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

export type AvatarTone = 'coordinator' | 1 | 2 | 3 | 4 | 5

/** A stable tint for a name, so the same agent or conversation keeps its color everywhere. */
export function toneFor(name: string): AvatarTone {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) | 0
  return ((Math.abs(hash) % 5) + 1) as AvatarTone
}

/**
 * The first letter of `name` on a tinted circle (Figma 48:3): 34px in the
 * list, 28px in search, 22px in pills and stacks, 16px on task rows.
 */
export function LetterAvatar({ name, tone = toneFor(name), size = 'list' }: { name: string; tone?: AvatarTone; size?: 'list' | 'search' | 'pill' | 'stack' | 'row' }) {
  const letter = Array.from(name.replace(/^mikka\s+/i, '').trim())[0]?.toUpperCase() ?? '·'
  return <Avatar aria-hidden="true" className={cn('after:border-0', size === 'list' && 'size-8.5', size === 'search' && 'size-7', (size === 'pill' || size === 'stack') && 'size-5.5', size === 'stack' && 'ring-2 ring-background', size === 'row' && 'size-4')}>
    <AvatarFallback className={cn('text-xs leading-none font-semibold text-avatar-foreground', size === 'row' && 'scale-75',
      tone === 'coordinator' && 'bg-sidebar-primary text-sidebar-primary-foreground', tone === 1 && 'bg-avatar-1', tone === 2 && 'bg-avatar-2',
      tone === 3 && 'bg-avatar-3', tone === 4 && 'bg-avatar-4', tone === 5 && 'bg-avatar-5')}>{letter}</AvatarFallback>
  </Avatar>
}
