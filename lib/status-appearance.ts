// Comma-style tags: light tint, dark text, hairline border. Never a solid saturated fill.
export const statusTones = {
  neutral: 'border-border bg-background text-ink-2',
  warning: 'border-tag-amber-border bg-tag-amber text-tag-amber-foreground',
  info: 'border-tag-blue-border bg-tag-blue text-tag-blue-foreground',
  success: 'border-tag-emerald-border bg-tag-emerald text-tag-emerald-foreground',
  destructive: 'border-tag-red-border bg-tag-red text-tag-red-foreground',
  focus: 'border-tag-violet-border bg-tag-violet text-tag-violet-foreground',
} as const

export type StatusTone = keyof typeof statusTones

export const statusDots: Record<StatusTone, string> = {
  neutral: 'bg-muted-foreground',
  warning: 'bg-warning',
  info: 'bg-tag-blue-foreground',
  success: 'bg-success',
  destructive: 'bg-destructive',
  focus: 'bg-info',
}

export function statusTone(value: string): StatusTone {
  switch (value) {
    case 'doing': case 'started': case 'paused': case 'atRisk': case 'high': return 'warning'
    case 'review': return 'info'
    case 'done': case 'completed': case 'onTrack': case 'open': return 'success'
    case 'urgent': case 'canceled': case 'offTrack': case 'closed': return 'destructive'
    case 'merged': return 'focus'
    default: return 'neutral'
  }
}
