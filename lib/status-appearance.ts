export const statusTones = {
  // R-31: a tinted fill, no stroke. Neutral uses the control overlay so it reads on grey too.
  neutral: 'border-transparent bg-control text-muted-foreground',
  warning: 'border-transparent bg-warning/10 text-warning-foreground',
  info: 'border-transparent bg-info/10 text-info-foreground',
  success: 'border-transparent bg-success/10 text-success-foreground',
  destructive: 'border-transparent bg-destructive/10 text-destructive',
  focus: 'border-transparent bg-info/10 text-info-foreground',
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
