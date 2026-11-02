'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { DIFF_WRAP_KEY, diffWrapFrom, splitPath, type ChangedFile, type DiffBlock, type DiffLine, type DiffWrap, type ThreadChanges } from '@/lib/thread-changes'

/**
 * A thread's 改动 tab (Figma 820:4843), read-only: no terminal, no inline
 * comments, nothing to edit. The file list is folded into 「N 个文件 +x −y」
 * until opened; the files follow one after another, each header sticking to the
 * top while its lines scroll; long lines wrap unless the person picked 横向滚动.
 */
export function ThreadChangesPane({ changes }: { changes: ThreadChanges }) {
  const [wrap, setWrap] = useDiffWrap()
  const [filesOpen, setFilesOpen] = useState(false)
  return <ThreadChangesView changes={changes} wrap={wrap} onWrapChange={setWrap} filesOpen={filesOpen} onFilesOpenChange={setFilesOpen} />
}

/** The person's long-line choice, kept on this device; wrapping until the stored value is read. */
export function useDiffWrap(): [DiffWrap, (next: DiffWrap) => void] {
  const [wrap, setWrap] = useState<DiffWrap>('wrap')
  useEffect(() => { try { setWrap(diffWrapFrom(window.localStorage.getItem(DIFF_WRAP_KEY))) } catch { /* storage unavailable */ } }, [])
  return [wrap, next => {
    setWrap(next)
    try { window.localStorage.setItem(DIFF_WRAP_KEY, next) } catch { /* storage unavailable */ }
  }]
}

export function ThreadChangesView({ changes, wrap, onWrapChange, filesOpen, onFilesOpenChange }: {
  changes: ThreadChanges; wrap: DiffWrap; onWrapChange: (next: DiffWrap) => void; filesOpen: boolean; onFilesOpenChange: (open: boolean) => void
}) {
  const t = useTranslations('IssueThreads')
  const listId = useId()
  const sections = useRef(new Map<string, HTMLElement>())
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())
  return <div data-slot="thread-changes" data-wrap={wrap} className="flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 items-center gap-2 px-3 py-2">
      <Button variant="ghost" size="sm" className="-ml-1.5 gap-1.5 px-1.5" aria-expanded={filesOpen} aria-controls={listId} onClick={() => onFilesOpenChange(!filesOpen)}>
        {filesOpen ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}
        <span className="font-medium">{t('changesFiles', { count: changes.files.length })}</span>
        <Counts additions={changes.additions} deletions={changes.deletions} />
      </Button>
      <span className="flex-1" />
      <ToggleGroup aria-label={t('changesLongLines')} variant="segment" size="sm" spacing={0.5} value={[wrap]} onValueChange={values => { const next = values[0]; if (next === 'wrap' || next === 'scroll') onWrapChange(next) }}>
        <ToggleGroupItem value="wrap">{t('changesWrap')}</ToggleGroupItem>
        <ToggleGroupItem value="scroll">{t('changesScroll')}</ToggleGroupItem>
      </ToggleGroup>
    </div>
    {filesOpen && <ul id={listId} aria-label={t('changesFileList')} data-slot="thread-changes-files" className="flex max-h-60 shrink-0 flex-col overflow-y-auto px-1.5 pb-2">
      {changes.files.map(file => { const { name, dir } = splitPath(file.path); return <li key={file.path}>
        <Button variant="ghost" size="sm" className="w-full min-w-0 justify-start gap-2 px-1.5 font-normal"
          onClick={() => sections.current.get(file.path)?.scrollIntoView({ block: 'start' })}>
          <span className="shrink-0">{name}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{dir}</span>
          <Counts additions={file.additions} deletions={file.deletions} />
        </Button>
      </li> })}
    </ul>}
    <div data-slot="thread-changes-scroll" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      {changes.files.map(file => {
        const open = !closed.has(file.path)
        return <FileSection key={file.path} file={file} open={open} wrap={wrap}
          ref={node => { if (node) sections.current.set(file.path, node); else sections.current.delete(file.path) }}
          onOpenChange={next => setClosed(current => { const copy = new Set(current); if (next) copy.delete(file.path); else copy.add(file.path); return copy })} />
      })}
    </div>
  </div>
}

/** 「改动 +128 −34」 on the thread's tab. */
export function ChangesTabLabel({ changes }: { changes: ThreadChanges | null }) {
  const t = useTranslations('IssueThreads')
  return <>{t('changesTab')}{changes && <Counts additions={changes.additions} deletions={changes.deletions} />}</>
}

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
    {additions > 0 && <span className="text-success-foreground">+{additions}</span>}
    {deletions > 0 && <span className="text-destructive">−{deletions}</span>}
  </span>
}

function FileSection({ file, open, wrap, onOpenChange, ref }: { file: ChangedFile; open: boolean; wrap: DiffWrap; onOpenChange: (open: boolean) => void; ref: (node: HTMLElement | null) => void }) {
  const t = useTranslations('IssueThreads')
  const { name, dir } = splitPath(file.path)
  return <section ref={ref} aria-label={file.path} data-slot="thread-changes-file" className="shrink-0 overflow-clip rounded-lg border border-border bg-background">
    {/* Sticks to the top of the scrolling list while this file's lines go by. */}
    <div data-slot="thread-changes-file-header" className="sticky top-0 z-10 flex h-10 items-center gap-2 bg-background pr-1.5 pl-1">
      <Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" aria-expanded={open} aria-label={t(open ? 'changesCollapseFile' : 'changesExpandFile', { name })} onClick={() => onOpenChange(!open)}>
        {open ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}
      </Button>
      <span className="shrink-0 truncate text-sm font-medium">{name}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{dir}</span>
      <Counts additions={file.additions} deletions={file.deletions} />
      {file.url && <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" aria-label={t('changesOpenFile')} render={<a href={file.url} target="_blank" rel="noopener noreferrer" />} />}>
        <ExternalLink data-icon="inline-start" />
      </TooltipTrigger><TooltipContent side="bottom">{t('changesOpenFile')}</TooltipContent></Tooltip>}
    </div>
    {open && (file.binary
      ? <p className="px-3 py-2 text-xs text-muted-foreground">{t('changesBinary')}</p>
      : <DiffRows blocks={file.blocks} wrap={wrap} />)}
  </section>
}


/** The file's lines in order; a run the diff left out is one 「N 行未修改」 row. */
export function DiffRows({ blocks, wrap }: { blocks: DiffBlock[]; wrap: DiffWrap }) {
  const t = useTranslations('IssueThreads')
  // Horizontal scrolling moves a run of lines together, with its numbers staying put.
  const runs: Array<{ kind: 'unchanged'; count: number; key: number } | { kind: 'lines'; lines: DiffLine[]; key: number }> = []
  blocks.forEach((block, index) => {
    if (block.kind === 'unchanged') runs.push({ kind: 'unchanged', count: block.count, key: index })
    else { const last = runs.at(-1); if (last?.kind === 'lines') last.lines.push(block.line); else runs.push({ kind: 'lines', lines: [block.line], key: index }) }
  })
  return <div className="font-mono text-xs/5">
    {runs.map(run => run.kind === 'unchanged'
      ? <p key={run.key} data-slot="thread-changes-unchanged" className="flex h-7 items-center bg-muted/60 px-3 font-sans text-muted-foreground">{t('changesUnchanged', { count: run.count })}</p>
      : wrap === 'wrap'
        ? <div key={run.key}>{run.lines.map((line, index) => <div key={index} data-slot="thread-changes-line" className={cn('flex', line.kind === 'added' && 'bg-success/10', line.kind === 'removed' && 'bg-destructive/10')}>
            <LineNumbers line={line} />
            <code className="min-w-0 flex-1 pr-3 break-all whitespace-pre-wrap">{line.text}</code>
          </div>)}</div>
        : <div key={run.key} data-slot="thread-changes-hscroll" className="overflow-x-auto">
            <div className="w-max min-w-full">{run.lines.map((line, index) => <div key={index} data-slot="thread-changes-line" className={cn('flex', line.kind === 'added' && 'bg-success/10', line.kind === 'removed' && 'bg-destructive/10')}>
              <span className="sticky left-0 z-[1] flex shrink-0 bg-background"><LineNumbers line={line} /></span>
              <code className="pr-3 whitespace-pre">{line.text}</code>
            </div>)}</div>
          </div>)}
  </div>
}

function LineNumbers({ line }: { line: DiffLine }) {
  return <span className={cn('grid shrink-0 grid-cols-[3rem_3rem_1.25rem] select-none', line.kind === 'added' && 'bg-success/10', line.kind === 'removed' && 'bg-destructive/10')}>
    <span className="pr-2 text-right text-muted-foreground tabular-nums">{line.old ?? ''}</span>
    <span className="pr-2 text-right text-muted-foreground tabular-nums">{line.new ?? ''}</span>
    <span className={cn('text-center', line.kind === 'added' ? 'text-success-foreground' : line.kind === 'removed' ? 'text-destructive' : 'text-muted-foreground')}>
      {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}
    </span>
  </span>
}
