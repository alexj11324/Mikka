'use client'

import { useTranslations } from 'next-intl'
import { CheckCircle2, CircleAlert, CircleHelp, CircleMinus, LoaderCircle } from 'lucide-react'
import { runIsActive, runStatusKey } from '@/lib/issue-run-conversation'
import { cn } from '@/lib/utils'

/** A thread is identified by its state, never by the dispatching Bot's avatar. */
export function ThreadStatusIcon({ status, waiting = false, small = false }: { status: string; /** 等你回复 (Figma 382:6469). */ waiting?: boolean; /** 14px, inside a chat chip; 20px otherwise. */ small?: boolean }) {
  const t = useTranslations('Coordinator.citation.runStatus')
  const threads = useTranslations('IssueThreads')
  // A run waiting for input is waiting on the person, not working: the same mark as a question (R-34).
  if (waiting || status === 'waiting_input') return <span role="img" aria-label={waiting ? threads('waiting') : t('waiting_input')} className="pointer-events-none relative shrink-0">
    <CircleHelp aria-hidden="true" className={cn(small ? 'size-3.5' : 'size-5', 'text-warning')} />
  </span>
  const active = runIsActive(status)
  const failed = ['failed', 'lost'].includes(status)
  const Icon = active ? LoaderCircle : status === 'succeeded' ? CheckCircle2 : failed ? CircleAlert : CircleMinus
  const key = runStatusKey(status)
  return <span role="img" aria-label={key ? t(key) : status} className="pointer-events-none relative shrink-0">
    <Icon aria-hidden="true" className={cn(small ? 'size-3.5' : 'size-5', active ? 'text-muted-foreground motion-safe:animate-spin' : status === 'succeeded' ? 'text-success' : failed ? 'text-destructive' : 'text-muted-foreground')} />
  </span>
}
