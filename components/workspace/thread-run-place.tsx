'use client'

import { useEffect } from 'react'
import useSWR from 'swr'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import { Cloud, Copy, Laptop, Server } from 'lucide-react'
import { toast } from 'sonner'
import { getThreadMachine } from '@/app/actions/agents'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { HarnessMark, harnessName } from '@/components/labels/entity-labels'
import { cloudShortId, machineDot, machineStateWord, systemLabel, type ThreadMachine, type ThreadMachineKind } from '@/lib/thread-machine'
import { cn } from '@/lib/utils'

const KIND_ICONS: Record<ThreadMachineKind, typeof Cloud> = { cloud: Cloud, laptop: Laptop, server: Server }

/** A cloud machine is named by its sandbox (「云电脑 i8k2m3」); a computer or server by its device name. */
export function useMachineName() {
  const t = useTranslations('ThreadRunPlace')
  return (machine: ThreadMachine) => machine.kind === 'cloud'
    ? machine.cloud ? t('cloudName', { id: cloudShortId(machine.cloud.sandboxId) }) : t('kinds.cloud')
    : machine.name || t(`kinds.${machine.kind}`)
}

/** The status dot (R-24): green while it can work, red on error, grey otherwise. */
function Dot({ dot, corner }: { dot: ReturnType<typeof machineDot>; corner?: boolean }) {
  return <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full bg-muted-foreground/50', dot === 'running' && 'bg-success', dot === 'failed' && 'bg-destructive', corner && 'absolute -top-0.5 -right-0.5 ring-2 ring-background')} />
}

/** The device type icon with its status dot on the top right (R-24, R-74). */
export function MachineIcon({ machine }: { machine: ThreadMachine }) {
  const Icon = KIND_ICONS[machine.kind]
  return <span className="relative inline-flex shrink-0">
    <Icon aria-hidden="true" className="size-4" />
    <Dot dot={machineDot(machine.state)} corner />
  </span>
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-2 text-xs">
    <dt className="text-muted-foreground">{label}</dt><dd className="min-w-0">{children}</dd>
  </div>
}

/** Which machine it is: name, state, and the facts that tell it apart (Figma `1053:2` 悬停卡片). */
export function MachineDetails({ machine }: { machine: ThreadMachine }) {
  const t = useTranslations('ThreadRunPlace')
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const name = useMachineName()(machine)
  const dot = machineDot(machine.state)
  const KindIcon = KIND_ICONS[machine.kind]
  const system = systemLabel(machine.platform, machine.arch)
  const at = (value: string) => format.dateTime(new Date(value), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  async function copyId(id: string) {
    try { await navigator.clipboard.writeText(id); toast.success(t('copied')) }
    catch { toast.error(t('copyFailed')) }
  }
  return <div className="flex flex-col gap-2.5" data-slot="thread-machine-details">
    <div className="flex min-w-0 items-center gap-2">
      <KindIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{name}</span>
      <span className={cn('flex shrink-0 items-center gap-1.5 text-xs font-medium', dot === 'running' ? 'text-success-foreground' : dot === 'failed' ? 'text-destructive-foreground' : 'text-muted-foreground')}>
        <Dot dot={dot} />{t(`states.${machineStateWord(machine)}`)}
      </span>
    </div>
    <dl className="flex flex-col gap-1.5">
      {machine.cloud && <>
        <Row label={t('id')}><span className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate font-mono">{machine.cloud.sandboxId}</span>
          <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-xs" className="shrink-0" aria-label={t('copyId')} onClick={() => { void copyId(machine.cloud!.sandboxId) }} />}><Copy data-icon="inline-start" /></TooltipTrigger><TooltipContent>{t('copyId')}</TooltipContent></Tooltip>
        </span></Row>
        {machine.cloud.template && <Row label={t('template')}><span className="font-mono">{machine.cloud.template}</span></Row>}
        <Row label={t('created')}>{at(machine.cloud.createdAt)}</Row>
        {machine.cloud.endedAt && <Row label={t('stopped')}>{at(machine.cloud.endedAt)}</Row>}
      </>}
      {system && <Row label={t('system')}>{system}</Row>}
      {machine.hostname && <Row label={t('host')}><span className="truncate">{machine.hostname}</span></Row>}
      {machine.state === 'offline' && machine.lastSeenAt && <Row label={t('lastSeen')}>{format.relativeTime(new Date(machine.lastSeenAt), now)}</Row>}
    </dl>
  </div>
}

/**
 * After an open thread's title: where it runs and which Agent runs it, as icons
 * only (Alex, 2026-11-06). Hovering the machine shows which one it is; the
 * Agent's mark names it and the Bot that dispatched it. Read once per run state,
 * never on a timer.
 */
export function ThreadRunPlace({ issueId, runId, status, harness, botName }: { issueId: string | null; runId: string; status: string; harness?: string; botName?: string }) {
  const t = useTranslations('ThreadRunPlace')
  const threads = useTranslations('IssueThreads')
  const { data: machine, mutate } = useSWR(['thread-machine', issueId, runId], () => getThreadMachine(issueId, runId), { revalidateOnFocus: false })
  // A cloud machine pauses or ends with its run; read again when the run's state moves.
  useEffect(() => { void mutate() }, [status, mutate])
  const name = useMachineName()
  const agent = harness ? harnessName(harness) : null
  return <span className="flex shrink-0 items-center gap-0.5" data-slot="thread-run-place">
    {machine && <HoverCard>
      <HoverCardTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground pointer-coarse:size-11"
        aria-label={t('label', { name: name(machine), state: t(`states.${machineStateWord(machine)}`) })} />}>
        <MachineIcon machine={machine} />
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-72 p-3"><MachineDetails machine={machine} /></HoverCardContent>
    </HoverCard>}
    {harness && agent && <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className="flex size-7 items-center justify-center rounded-md outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" />}><HarnessMark harness={harness} /></TooltipTrigger>
      <TooltipContent side="bottom">{botName ? `${agent} · ${botName} ${threads('dispatched')}` : agent}</TooltipContent>
    </Tooltip>}
  </span>
}
