'use client'

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { ChevronLeft, ChevronRight, Download, FileText, Play, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { withBasePath } from '@/lib/base-path'
import { cn } from '@/lib/utils'
import { evidenceMediaPath, formatDuration, groupByStage, mediaKind, stepIndex, type EvidenceEntry } from '@/lib/factory/evidence-view'
import { ShortSha } from './short-sha'

const mediaUrl = (taskId: string, entry: EvidenceEntry) => entry.captureId ? withBasePath(evidenceMediaPath(taskId, entry.captureId)) : null

/** One entry's name: a capture's title, or the artifact reference for text. */
const nameOf = (entry: EvidenceEntry) => entry.title?.trim() || entry.artifact

/** The thumbnail Figma calls Factory/EvidenceThumb: 104×65, a screenshot, a recording with its length, or text. */
function EvidenceThumb({ taskId, entry, selected, label, onOpen }: { taskId: string; entry: EvidenceEntry; selected?: boolean; label: string; onOpen: () => void }) {
  const media = mediaKind(entry)
  const duration = formatDuration(entry.durationMs)
  const [broken, setBroken] = useState(false)
  return <Button variant="ghost" aria-label={label} aria-current={selected ? 'true' : undefined} onClick={onOpen}
    data-kind={media ?? 'text'}
    className={cn('relative h-[65px] w-[104px] shrink-0 overflow-hidden rounded-md bg-muted p-0',
      media === null && 'bg-foreground text-background hover:bg-foreground/90 hover:text-background', selected && 'ring-2 ring-primary')}>
    {media === 'image' && !broken && <img src={mediaUrl(taskId, entry)!} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} className="size-full object-cover object-top" />}
    {media === 'video' && <>
      <span className="flex size-6 items-center justify-center rounded-full bg-background/90 text-foreground"><Play data-icon="inline-start" aria-hidden="true" className="size-3 fill-current" /></span>
      {duration && <span className="absolute right-1 bottom-1 rounded-sm bg-foreground/70 px-1 font-mono text-xs text-background">{duration}</span>}
    </>}
    {media === null && <span className="flex max-w-full items-center gap-1 px-2 font-mono text-xs"><FileText data-icon="inline-start" aria-hidden="true" className="size-3 shrink-0" /><span className="truncate">{entry.artifact}</span></span>}
  </Button>
}

/**
 * The acceptance window's evidence (Figma 357:4750, frame 06): screenshots and
 * recordings as thumbnails and text as chips, grouped by the stage that
 * produced them. Opening one opens the viewer at that entry.
 */
export function EvidenceList({ taskId, entries, onOpen }: { taskId: string; entries: readonly EvidenceEntry[]; onOpen: (index: number) => void }) {
  const t = useTranslations('FactoryAcceptance')
  if (!entries.length) return <p className="text-xs text-muted-foreground">{t('evidenceEmpty')}</p>
  return <div className="flex flex-col gap-4">
    {groupByStage(entries).map(group => <div key={group.stage} className="flex flex-col gap-2">
      <h5 className="text-xs text-muted-foreground">{t(`stage.${group.stage}`)}</h5>
      <div className="flex flex-wrap items-center gap-2">
        {group.items.map(({ entry, index }) => mediaKind(entry)
          ? <EvidenceThumb key={entry.artifact + index} taskId={taskId} entry={entry} label={t('captureLabel', { kind: t(`kind.${entry.kind}`), title: nameOf(entry) })} onOpen={() => onOpen(index)} />
          : <Button key={entry.artifact + index} variant="outline" size="sm" aria-label={entry.artifact} onClick={() => onOpen(index)}>
            <FileText data-icon="inline-start" aria-hidden="true" /><span className="max-w-60 truncate font-mono">{entry.artifact}</span>
          </Button>)}
      </div>
    </div>)}
  </div>
}

type Load = { state: 'loading' } | { state: 'ready'; content?: string } | { state: 'error' }

/**
 * The evidence viewer (Figma 357:4750, frames 12 screenshot, 13 recording,
 * 14 log): the entry on a grey stage with previous/next, a filmstrip of every
 * entry, and ←/→ to move. Media comes from the captures serve path; text from
 * the approval route.
 */
export function EvidenceViewer({ taskId, entries, index, sha, environment, readText, onIndex, onClose }: {
  taskId: string
  entries: readonly EvidenceEntry[]
  index: number
  sha?: string
  environment?: string | null
  readText: (artifact: string) => Promise<string>
  onIndex: (index: number) => void
  onClose: () => void
}) {
  const t = useTranslations('FactoryAcceptance')
  const format = useFormatter()
  const entry = entries[index]
  const media = entry ? mediaKind(entry) : null
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const texts = useRef(new Map<string, string>())
  const strip = useRef<HTMLDivElement>(null)

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
  }, [index])

  const go = useCallback((delta: number) => onIndex(stepIndex(index, delta, entries.length)), [index, entries.length, onIndex])
  const onKeyDown = (event: KeyboardEvent) => {
    // Inside a playing video the arrows seek; leave them to the player.
    if ((event.target as HTMLElement | null)?.tagName === 'VIDEO') return
    if (event.key === 'ArrowLeft') { event.preventDefault(); go(-1) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); go(1) }
    else if (event.key === 'Home') { event.preventDefault(); onIndex(0) }
    else if (event.key === 'End') { event.preventDefault(); onIndex(Math.max(0, entries.length - 1)) }
  }
  if (!entry) return null
  const url = mediaUrl(taskId, entry)
  const src = url && attempt ? `${url}?attempt=${attempt}` : url
  const download = url ?? (load.state === 'ready' && load.content !== undefined ? `data:text/plain;charset=utf-8,${encodeURIComponent(load.content)}` : null)
  const retry = () => { setLoad({ state: 'loading' }); setAttempt(value => value + 1) }

  return <Dialog open onOpenChange={value => { if (!value) onClose() }}>
    <DialogContent showCloseButton={false} aria-describedby={undefined} onKeyDown={onKeyDown}
      className="flex h-[calc(100svh-2rem)] max-h-[50rem] flex-col gap-0 overflow-hidden p-0 sm:max-w-[70rem] max-sm:h-svh max-sm:max-h-none max-sm:max-w-none max-sm:rounded-none">
      <header className="flex h-14 shrink-0 items-center gap-2 px-4 sm:px-5">
        <DialogTitle className="min-w-0 truncate text-sm font-medium">{media ? nameOf(entry) : <code>{entry.artifact}</code>}</DialogTitle>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums" data-testid="evidence-counter">{t('counter', { index: String(index + 1), total: String(entries.length) })}</span>
        <span className="flex-1" />
        <div className="hidden items-center gap-1 sm:flex">
          {sha && <ShortSha sha={sha} tone="neutral" />}
          {environment && <Badge variant="outline" tone="neutral">{environment}</Badge>}
          {entry.recordedAt && <Badge variant="outline" tone="neutral">{format.dateTime(new Date(entry.recordedAt), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</Badge>}
        </div>
        {download && <Button variant="ghost" size="icon-sm" aria-label={t('download')} nativeButton={false} role="link" render={<a href={download} download={media ? nameOf(entry) : `${entry.artifact.replace(/[^\w.-]+/g, '-')}.txt`} />}><Download data-icon="inline-start" /></Button>}
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
              <img key={src} src={src!} alt={nameOf(entry)} draggable={false} onLoad={() => setLoad({ state: 'ready' })} onError={() => setLoad({ state: 'error' })}
                className={cn('max-h-full max-w-full rounded-lg object-contain', load.state !== 'ready' && 'invisible')} />
            </>
              : media === 'video' ? <>
                {load.state === 'loading' && <Skeleton data-testid="evidence-loading" className="absolute inset-0 m-auto aspect-video max-h-full w-full max-w-[52rem]" />}
                <video key={src} src={src!} controls playsInline preload="metadata" aria-label={nameOf(entry)} onLoadedMetadata={() => setLoad({ state: 'ready' })} onError={() => setLoad({ state: 'error' })}
                  className={cn('max-h-full max-w-full rounded-lg bg-muted', load.state !== 'ready' && 'invisible')} />
              </>
                : load.state === 'loading' ? <Skeleton data-testid="evidence-loading" className="size-full max-w-[55rem] rounded-xl" />
                  : <pre className="size-full max-w-[55rem] overflow-auto rounded-xl bg-background px-5 py-4 font-mono text-xs whitespace-pre-wrap break-words">{load.content}</pre>}
        </div>
        <Button variant="outline" size="icon" aria-label={t('next')} disabled={index >= entries.length - 1} onClick={() => go(1)}
          className="absolute right-2 z-10 rounded-full sm:static sm:shrink-0"><ChevronRight data-icon="inline-start" /></Button>
      </div>
      <div ref={strip} role="group" aria-label={t('allEvidence')} className="flex h-[89px] shrink-0 items-center gap-2 overflow-x-auto px-4 sm:justify-center">
        {entries.map((item, position) => <EvidenceThumb key={item.artifact + position} taskId={taskId} entry={item} selected={position === index}
          label={mediaKind(item) ? t('captureLabel', { kind: t(`kind.${item.kind}`), title: nameOf(item) }) : item.artifact} onOpen={() => onIndex(position)} />)}
      </div>
    </DialogContent>
  </Dialog>
}
