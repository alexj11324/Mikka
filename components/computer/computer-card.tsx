'use client'

import { useState } from 'react'
import { Cloud, Monitor, ShieldCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useComputer } from '@/hooks/use-computer'
import { computerApi } from '@/lib/computer/client'
import type { ApprovalView, ComputerTask } from '@/lib/computer/types'
import { cn } from '@/lib/utils'
import { useComputerAgentName, useRegisterComputerThread, useThreadName } from './computer-agents'
import { ComputerScreen } from './computer-screen'
import { ComputerStatusBadge, taskStatus } from './computer-status'
import { ComputerViewer } from './computer-viewer'

/** 允许 / 拒绝 / 本任务内都允许 for the one operation the agent is waiting on. */
function ApprovalBar({ approval }: { approval: ApprovalView }) {
  const t = useTranslations('Computer.approval')
  const { mutate } = useComputer(approval.agentId)
  const [sending, setSending] = useState<string | null>(null)
  async function decide(decision: 'approve' | 'deny', scope: 'once' | 'run') {
    setSending(`${decision}-${scope}`)
    try {
      await computerApi.decide(approval, { digest: approval.digest, decision, scope })
      await mutate()
    } catch { toast.error(t('failed')) } finally { setSending(null) }
  }
  return <div className="flex flex-col gap-2">
    <p className="flex min-w-0 items-center gap-1.5 text-sm"><ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-attention" /><span className="shrink-0 font-medium">{approval.summary}</span>{approval.action.text && <span className="truncate text-muted-foreground">{approval.action.text}</span>}</p>
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="sm" className="font-normal text-muted-foreground" disabled={!!sending} onClick={() => { void decide('approve', 'run') }}>{t('allowRun')}</Button>
      <Button variant="outline" size="sm" className="ml-auto" disabled={!!sending} onClick={() => { void decide('deny', 'once') }}>{t('deny')}</Button>
      <Button size="sm" className="bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90" disabled={!!sending} onClick={() => { void decide('approve', 'once') }}>{t('allow')}</Button>
    </div>
  </div>
}

/**
 * The 电脑 card in a conversation (Figma 115:1265): one per computer task,
 * with the task sentence, the state and the live screen. Approval happens
 * here. While the computer is asleep or waking it shrinks to a chip.
 */
export function ComputerCard({ agentId, agentName, runId, task, thread, state = 'working' }: Omit<ComputerTask, 'state'> & { state?: ComputerTask['state']; agentName?: string; thread?: string }) {
  const t = useTranslations('Computer')
  const name = useComputerAgentName(agentId, agentName)
  const threadName = useThreadName(agentId, runId, thread, task)
  useRegisterComputerThread({ agentId, agentName: name, runId, name: threadName })
  const { data: computer } = useComputer(agentId)
  const [viewing, setViewing] = useState(false)
  const status = taskStatus(state, computer, runId)
  const approval = status === 'approval' && computer?.pendingApproval?.runId === runId ? computer.pendingApproval : undefined
  if (status === 'sleeping' || status === 'waking') return <span className="inline-flex w-fit max-w-full items-center gap-2 rounded-lg border bg-card py-1 pr-1 pl-2.5 text-sm">
    <Cloud aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    <span className="truncate">{t('computerOf', { name })}</span>
    <ComputerStatusBadge status={status} />
  </span>
  return <section aria-label={t('card')} className={cn('flex w-full min-w-0 flex-col gap-3 rounded-xl border p-3', approval ? 'bg-muted/60' : 'bg-card')}>
    <div className="flex items-center gap-2">
      <Monitor aria-hidden="true" className="size-4 shrink-0" />
      <h3 className="text-sm font-medium">{t('cardTitle')}</h3>
      <ComputerStatusBadge status={status} end />
    </div>
    <p className="text-sm">{task}</p>
    <Button variant="ghost" aria-label={t('openScreen', { name })} className="h-auto w-full rounded-lg p-0 hover:bg-transparent" onClick={() => setViewing(true)}>
      <ComputerScreen agentId={agentId} name={name} showTarget={status !== 'done' && status !== 'failed'} />
    </Button>
    {approval && <ApprovalBar approval={approval} />}
    {viewing && <ComputerViewer agentId={agentId} name={name} open={viewing} onOpenChange={setViewing} />}
  </section>
}
