export const statusTones = {
  neutral: 'border-muted-foreground/20 bg-muted/50 text-muted-foreground',
  warning: 'border-warning/25 bg-warning/10 text-warning-foreground',
  info: 'border-info/25 bg-info/10 text-info-foreground',
  success: 'border-success/25 bg-success/10 text-success-foreground',
  destructive: 'border-destructive/25 bg-destructive/10 text-destructive',
  focus: 'border-info/25 bg-info/10 text-info-foreground',
} as const

export type StatusTone = keyof typeof statusTones

export const statusDots: Record<StatusTone, string> = {
  neutral: 'bg-muted-foreground',
  warning: 'bg-warning',
  info: 'bg-info',
  success: 'bg-success',
  destructive: 'bg-destructive',
  focus: 'bg-info',
}

export function statusTone(value: string): StatusTone {
  switch (value) {
    case 'doing': case 'started': case 'paused': case 'atRisk': case 'normal': return 'warning'
    case 'review': return 'info'
    case 'done': case 'completed': case 'onTrack': case 'low': case 'open': return 'success'
    case 'urgent': case 'canceled': case 'offTrack': case 'closed': return 'destructive'
    case 'high': case 'merged': return 'focus'
    default: return 'neutral'
  }
}

/** Icon color for a status on its own, without a badge around it (board cards). */
export const statusIconTints: Record<StatusTone, string> = {
  neutral: 'text-muted-foreground',
  warning: 'text-warning-foreground',
  info: 'text-info-foreground',
  success: 'text-success-foreground',
  destructive: 'text-destructive',
  focus: 'text-info-foreground',
}

/** Agent sphere gradients (Figma 77:2), keyed by avatar tone. */
export const SPHERE_TONES = {
  coordinator: 'from-sidebar-primary/45 to-sidebar-primary', t1: 'from-avatar-1/45 to-avatar-1', t2: 'from-avatar-2/45 to-avatar-2',
  t3: 'from-avatar-3/45 to-avatar-3', t4: 'from-avatar-4/45 to-avatar-4', t5: 'from-avatar-5/45 to-avatar-5',
} as const
