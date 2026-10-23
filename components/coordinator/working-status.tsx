'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { motion, useReducedMotion } from 'motion/react'
import { useWorkingParticipants } from '@/hooks/use-working-participants'
import { workersKey, workingAvatars, workingLabel } from '@/lib/working-status'
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from '@/components/ui/avatar'
import { ActionSwapRollText } from '@/components/motion/action-swap-roll'
import { TextShimmer } from '@/components/motion/text-shimmer'

const COALESCE_MS = 300

/** Waits until the value has held still for `delay`, so bursts only show their last state. */
function useSettled<T>(value: T, delay: number) {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return settled
}

/** True while the element is in the viewport and the page is visible. */
function useOnScreen<T extends Element>() {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(true)
  const [pageVisible, setPageVisible] = useState(true)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? true))
    observer.observe(element)
    return () => observer.disconnect()
  })
  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState === 'visible')
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return [ref, inView && pageVisible] as const
}

/** "Who is working" row above the Coordinator composer. Hidden when nobody is working. */
export function WorkingStatus({ coordinatorWorking }: { coordinatorWorking: boolean }) {
  const t = useTranslations('Coordinator.workingStatus')
  const reduce = useReducedMotion()
  const workers = useWorkingParticipants({ coordinatorWorking })
  const key = useSettled(workersKey(workers), COALESCE_MS)
  const settled = useMemo(() => workers.filter(worker => key.split('|').includes(worker.id)), [workers, key])
  const [ref, onScreen] = useOnScreen<HTMLDivElement>()
  const label = workingLabel(settled.map(worker => worker.name))
  if (!label) return null
  const { shown, overflow } = workingAvatars(settled)
  const text = label.key === 'many' ? t('many', label.values) : t(label.key, label.values)
  const shimmer = onScreen && !reduce

  const row = <span className="flex min-w-0 items-center gap-2">
    <AvatarGroup className="-space-x-1.5">
      {shown.map(worker => <Avatar key={worker.id} className="size-5">
        {worker.avatarUrl && <AvatarImage src={worker.avatarUrl} alt="" />}
        <AvatarFallback className="text-xs">{worker.name.slice(0, 1)}</AvatarFallback>
      </Avatar>)}
      {overflow > 0 && <AvatarGroupCount className="size-5 text-xs">+{overflow}</AvatarGroupCount>}
    </AvatarGroup>
    <span aria-live="polite" data-working-text className="min-w-0 truncate text-sm leading-5 text-muted-foreground">
      {shimmer ? <TextShimmer duration={2}>{text}</TextShimmer> : <span data-static-text>{text}</span>}
    </span>
  </span>

  return <div ref={ref} data-working-status className="flex h-7 min-w-0 items-center overflow-hidden">
    {reduce
      ? <motion.span key={key} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.12 }} className="flex min-w-0">{row}</motion.span>
      : <ActionSwapRollText value={key} className="min-w-0">{row}</ActionSwapRollText>}
  </div>
}
