'use client'

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { ChevronLeft, ChevronRight, CircleCheck, CircleX, Download, FileText, Play, Server, SquareTerminal, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { withBasePath } from '@/lib/base-path'
import { cn } from '@/lib/utils'
import { activeStep, evidenceMediaPath, formatDuration, mediaKind, stepIndex, type EvidenceEntry } from '@/lib/factory/evidence-view'
import type { AcceptanceItem } from '@/lib/factory/acceptance-view'
import { ShortSha } from './short-sha'

const mediaUrl = (taskId: string, entry: EvidenceEntry) => entry.captureId ? withBasePath(evidenceMediaPath(taskId, entry.captureId)) : null

type Translate = ReturnType<typeof useTranslations<'FactoryAcceptance'>>

/** What an entry is called: a capture's title, the command a verify run ran, or its stage and kind (never a raw id). */
export function itemLabel(t: Translate, { entry, command }: AcceptanceItem) {
  if (mediaKind(entry)) return t('captureLabel', { kind: t(`kind.${entry.kind}`), title: entry.title?.trim() || t(`kind.${entry.kind}`) })
  if (command) return command.text
  return t('textLabel', { stage: t(`stage.${entry.stage}`), kind: t(`kind.${entry.kind}`) })
}

/**
 * Figma 13 「操作」: the recording's steps, each its time and what the agent did.
 * A step seeks the video; the one playing is marked as current.
 */
function RecordingSteps({ steps, current, onSeek }: { steps: { atMs: number; label: string }[]; current: number; onSeek: (ms: number) => void }) {
  const t = useTranslations('FactoryAcceptance')
  return <section aria-label={t('steps', { count: String(steps.length) })} className="flex max-h-full min-h-0 w-full shrink-0 flex-col gap-1 sm:w-60">
    <h3 className="px-2 text-xs text-muted-foreground">{t('steps', { count: String(steps.length) })}</h3>
    <ol className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
      {steps.map((step, position) => <li key={`${step.atMs}:${position}`}>
        <Button variant="ghost" aria-current={position === current || undefined} onClick={() => onSeek(step.atMs)}
          className="h-auto w-full min-w-0 items-baseline justify-start gap-3 px-2 py-1.5 text-left font-normal whitespace-normal aria-[current=true]:bg-background">
          <span className="w-9 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{formatDuration(step.atMs)}</span>
          <span className="min-w-0 flex-1 break-words">{step.label}</span>
        </Button>
      </li>)}
    </ol>
  </section>
}

/** `exit 0` in green, anything else in red. */
function Exit({ code }: { code: number | null }) {
  if (code === null) return null
  return <span className={cn('font-mono', code === 0 ? 'text-success' : 'text-destructive')}>exit {code}</span>
}

/** Figma `Factory/EvidenceThumb`: 104×65, a screenshot, a recording with its length, or a terminal tile for text. */
function EvidenceThumb({ taskId, item, selected, label, onOpen }: { taskId: string; item: AcceptanceItem; selected?: boolean; label: string; onOpen: () => void }) {
  const { entry, command } = item
  const media = mediaKind(entry)
  const duration = formatDuration(entry.durationMs)
  const [broken, setBroken] = useState(false)
  return <Button variant="ghost" aria-label={label} aria-current={selected ? 'true' : undefined} onClick={onOpen}
    data-kind={media ?? 'text'}
    className={cn('relative h-[65px] w-[104px] shrink-0 overflow-hidden rounded-lg bg-muted p-0',
      media === null && 'flex-col items-start justify-center gap-0.5 bg-foreground px-2.5 text-background hover:bg-foreground/90 hover:text-background', selected && 'ring-2 ring-primary')}>
    {media === 'image' && !broken && <img src={mediaUrl(taskId, entry)!} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} className="size-full object-cover object-top" />}
    {media === 'video' && <>
      <span className="flex size-6 items-center justify-center rounded-full bg-background/90 text-foreground"><Play data-icon="inline-start" aria-hidden="true" className="size-3 fill-current" /></span>
      {duration && <span className="absolute right-1 bottom-1 rounded-sm bg-foreground/70 px-1 text-xs text-background">{duration}</span>}
    </>}
    {media === null && (command
      ? <>
        <span className="max-w-full truncate font-mono text-xs">$ {command.text}</span>
        <span className="text-xs"><Exit code={command.exitCode} /></span>
      </>
      : <span className="flex max-w-full items-center gap-1 text-xs"><FileText data-icon="inline-start" aria-hidden="true" className="size-3 shrink-0" /><span className="truncate">{label}</span></span>)}
  </Button>
}

/** Figma `日志` chip: a command and its exit code, or the entry's stage and kind. */
function EvidenceChip({ item, label, onOpen }: { item: AcceptanceItem; label: string; onOpen: () => void }) {
  return <Button variant="secondary" size="sm" aria-label={label} onClick={onOpen} className="max-w-full font-normal">
    {item.command ? <SquareTerminal data-icon="inline-start" aria-hidden="true" /> : <FileText data-icon="inline-start" aria-hidden="true" />}
    <span className={cn('truncate', item.command && 'font-mono')}>{label}</span>
    {item.command && item.command.exitCode !== null && <>
      <span aria-hidden="true" className="text-muted-foreground">·</span>
      <Exit code={item.command.exitCode} />
    </>}
  </Button>
}

/** One criterion's evidence (frame 06): screenshots and recordings as thumbnails, text as chips. */
export function CriterionEvidence({ taskId, items, onOpen }: { taskId: string; items: readonly AcceptanceItem[]; onOpen: (index: number) => void }) {
  const t = useTranslations('FactoryAcceptance')
  return <div className="flex flex-wrap items-center gap-2">
    {items.map((item, index) => mediaKind(item.entry)
      ? <EvidenceThumb key={item.entry.artifact + index} taskId={taskId} item={item} label={itemLabel(t, item)} onOpen={() => onOpen(index)} />
      : <EvidenceChip key={item.entry.artifact + index} item={item} label={itemLabel(t, item)} onOpen={() => onOpen(index)} />)}
  </div>
}

type Load = { state: 'loading' } | { state: 'ready'; content?: string } | { state: 'error' }

/**
 * The evidence viewer (Figma 357:4750, frames 12 screenshot, 13 recording,
 * 14 log): one criterion's evidence on a grey stage with previous/next, a
 * filmstrip, and ←/→ to move. The header names the criterion with its result.
 * Media comes from the captures serve path; text from the approval route.
 */
export function EvidenceViewer({ taskId, items, index, title, passed, sha, environment, readText, onIndex, onClose }: {
  taskId: string
  items: readonly AcceptanceItem[]
  index: number
  /** The criterion these items prove; without one the entry names itself. */
  title?: string | null
  passed?: boolean | null
  sha?: string
  environment?: string | null
  readText: (artifact: string) => Promise<string>
  onIndex: (index: number) => void
  onClose: () => void
}) {
  const t = useTranslations('FactoryAcceptance')
  const format = useFormatter()
  const item = items[index]
  const entry = item?.entry
  const media = entry ? mediaKind(entry) : null
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const texts = useRef(new Map<string, string>())
  const strip = useRef<HTMLDivElement>(null)
  const player = useRef<HTMLVideoElement>(null)
  const [playingMs, setPlayingMs] = useState(0)

  const reader = useRef(readText)
  useEffect(() => { reader.current = readText }, [readText])
  // Keyed by position and name, not object identity: a revalidated manifest must not reset a loaded image.
  const artifact = entry?.artifact
  useEffect(() => {
    if (!artifact) return
    if (media) { setLoad({ state: 'loading' }); return }
    const cached = texts.current.get(artifact)
    if (cached !== undefined) { setLoad({ state: 'ready', content: cached }); return }
    let live = true
    setLoad({ state: 'loading' })
    reader.current(artifact).then(content => {
      texts.current.set(artifact, content)
      if (live) setLoad({ state: 'ready', content })
    }, () => { if (live) setLoad({ state: 'error' }) })
    return () => { live = false }
  }, [index, artifact, media, attempt])

  useEffect(() => {
    strip.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    setPlayingMs(0)
  }, [index])

  const go = useCallback((delta: number) => onIndex(stepIndex(index, delta, items.length)), [index, items.length, onIndex])
  const onKeyDown = (event: KeyboardEvent) => {
    // Inside a playing video the arrows seek; leave them to the player.
    if ((event.target as HTMLElement | null)?.tagName === 'VIDEO') return
    if (event.key === 'ArrowLeft') { event.preventDefault(); go(-1) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); go(1) }
    else if (event.key === 'Home') { event.preventDefault(); onIndex(0) }
    else if (event.key === 'End') { event.preventDefault(); onIndex(Math.max(0, items.length - 1)) }
  }
  if (!item || !entry) return null
  const label = itemLabel(t, item)
  const url = mediaUrl(taskId, entry)
  const src = url && attempt ? `${url}?attempt=${attempt}` : url
  const download = url ?? (load.state === 'ready' && load.content !== undefined ? `data:text/plain;charset=utf-8,${encodeURIComponent(load.content)}` : null)
  const retry = () => { setLoad({ state: 'loading' }); setAttempt(value => value + 1) }
  const name = media ? entry.title?.trim() || label : label
  const steps = media === 'video' && Array.isArray(entry.steps) ? entry.steps : []
  const seek = (ms: number) => { const video = player.current; if (video) { video.currentTime = ms / 1000; setPlayingMs(ms) } }

  return <Dialog open onOpenChange={value => { if (!value) onClose() }}>
    <DialogContent showCloseButton={false} aria-describedby={undefined} onKeyDown={onKeyDown}
      className="flex h-[calc(100svh-2rem)] max-h-[50rem] flex-col gap-0 overflow-hidden p-0 sm:max-w-[70rem] max-sm:h-svh max-sm:max-h-none max-sm:max-w-none max-sm:rounded-none">
      <header className="flex h-14 shrink-0 items-center gap-2 px-4 sm:px-5">
        {title && passed !== null && passed !== undefined && (passed
          ? <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-success" />
          : <CircleX aria-hidden="true" className="size-4 shrink-0 text-destructive" />)}
        <DialogTitle className="min-w-0 truncate text-sm font-medium">{title || name}</DialogTitle>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums" data-testid="evidence-counter">{t('counter', { index: String(index + 1), total: String(items.length) })}</span>
        <span className="flex-1" />
        <div className="hidden items-center gap-1 sm:flex">
          {sha && <ShortSha sha={sha} tone="neutral" />}
          {environment && <Badge variant="outline" tone="neutral"><Server aria-hidden="true" />{environment}</Badge>}
          {entry.recordedAt && <Badge variant="outline" tone="neutral">{format.dateTime(new Date(entry.recordedAt), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</Badge>}
        </div>
        {download && <Button variant="ghost" size="icon-sm" aria-label={t('download')} nativeButton={false} role="link" render={<a href={download} download={media ? name : `${label.replace(/[^\w.-]+/g, '-')}.txt`} />}><Download data-icon="inline-start" /></Button>}
        <Button variant="ghost" size="icon-sm" aria-label={t('closeEvidence')} onClick={onClose}><X data-icon="inline-start" /></Button>
      </header>
      <div className="relative flex min-h-0 flex-1 items-center justify-center gap-4 bg-muted px-4 py-6 sm:px-6">
        <Button variant="outline" size="icon" aria-label={t('previous')} disabled={index === 0} onClick={() => go(-1)}
          className="absolute left-2 z-10 rounded-full sm:static sm:shrink-0"><ChevronLeft data-icon="inline-start" /></Button>
        <div className="relative flex size-full min-w-0 items-center justify-center" aria-busy={load.state === 'loading' || undefined}>
          {load.state === 'error'
            ? <div role="alert" className="flex flex-col items-center gap-3">
              <p className="text-xs text-muted-foreground">{t('artifactError')}</p>
              <Button size="sm" variant="outline" onClick={retry}>{t('retry')}</Button>
            </div>
            : media === 'image' ? <>
              {load.state === 'loading' && <Skeleton data-testid="evidence-loading" className="absolute inset-0 m-auto aspect-video max-h-full w-full max-w-[52rem]" />}
              <img key={src} src={src!} alt={name} draggable={false} onLoad={() => setLoad({ state: 'ready' })} onError={() => setLoad({ state: 'error' })}
                className={cn('max-h-full max-w-full rounded-lg object-contain', load.state !== 'ready' && 'invisible')} />
            </>
              : media === 'video' ? <div className="flex size-full min-h-0 min-w-0 flex-col items-center justify-center gap-4 sm:flex-row">
                <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center">
                  {load.state === 'loading' && <Skeleton data-testid="evidence-loading" className="absolute inset-0 m-auto aspect-video max-h-full w-full max-w-[52rem]" />}
                  <video ref={player} key={src} src={src!} controls playsInline preload="metadata" aria-label={name} onLoadedMetadata={() => setLoad({ state: 'ready' })} onError={() => setLoad({ state: 'error' })}
                    onTimeUpdate={event => setPlayingMs(event.currentTarget.currentTime * 1000)}
                    className={cn('max-h-full max-w-full rounded-lg bg-muted', load.state !== 'ready' && 'invisible')} />
                </div>
                {steps.length > 0 && <RecordingSteps steps={steps} current={activeStep(steps, playingMs)} onSeek={seek} />}
              </div>
                : load.state === 'loading' ? <Skeleton data-testid="evidence-loading" className="size-full max-w-[55rem] rounded-xl" />
                  : <div className="flex size-full max-w-[55rem] flex-col overflow-hidden rounded-xl bg-background">
                    {item.command && <div className="flex shrink-0 items-center gap-3 px-5 pt-4 font-mono text-xs">
                      <span className="min-w-0 flex-1 truncate">$ {item.command.text}</span>
                      <Exit code={item.command.exitCode} />
                    </div>}
                    <pre className="min-h-0 flex-1 overflow-auto px-5 py-4 font-mono text-xs whitespace-pre-wrap break-words">{load.content}</pre>
                  </div>}
        </div>
        <Button variant="outline" size="icon" aria-label={t('next')} disabled={index >= items.length - 1} onClick={() => go(1)}
          className="absolute right-2 z-10 rounded-full sm:static sm:shrink-0"><ChevronRight data-icon="inline-start" /></Button>
      </div>
      <div ref={strip} role="group" aria-label={t('allEvidence')} className="flex h-[89px] shrink-0 items-center gap-2 overflow-x-auto px-4 sm:justify-center">
        {items.map((other, position) => <EvidenceThumb key={other.entry.artifact + position} taskId={taskId} item={other} selected={position === index}
          label={itemLabel(t, other)} onOpen={() => onIndex(position)} />)}
      </div>
    </DialogContent>
  </Dialog>
}
