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
