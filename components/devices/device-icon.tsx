import { Cloud, Laptop, Terminal } from 'lucide-react'
import { cn } from '@/lib/utils'

export type DeviceState = 'online' | 'offline' | 'error'

/**
 * A machine's icon with its state as a dot on the top-right corner, the way
 * Claude marks devices (Figma 192:3243): green online, grey offline, red when
 * it failed. `label` is the state in words for screen readers; `surface` is
 * what the dot's ring blends into.
 */
export function DeviceIcon({ kind, state, label, surface = 'popover' }: { kind: 'personal' | 'server' | 'cloud'; state: DeviceState; label: string; surface?: 'popover' | 'muted' }) {
  const Icon = kind === 'cloud' ? Cloud : kind === 'server' ? Terminal : Laptop
  return <span className="relative inline-flex shrink-0 pr-0.5">
    <Icon aria-hidden="true" className="size-4" />
    <span aria-hidden="true" className={cn('absolute -top-0.5 -right-1 size-2 rounded-full ring-2', surface === 'popover' ? 'ring-popover' : 'ring-muted',
      state === 'online' && 'bg-success', state === 'offline' && 'bg-muted-foreground/50', state === 'error' && 'bg-destructive')} />
    <span className="sr-only">{label}</span>
  </span>
}
