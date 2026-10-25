import { cn } from '@/lib/utils'

/** The 8px dot in front of a task: green running, yellow waiting on you, red failed, blue done, grey otherwise. */
export function StatusDot({ status }: { status: string }) {
  return <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full bg-muted-foreground/50',
    (status === 'doing' || status === 'running') && 'bg-success',
    (status === 'review' || status === 'waiting') && 'bg-warning',
    status === 'failed' && 'bg-destructive',
    status === 'done' && 'bg-label-blue')} />
}
