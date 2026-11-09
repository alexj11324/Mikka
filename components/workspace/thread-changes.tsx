'use client'

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getSingularPatch, Virtualizer } from '@pierre/diffs'
import { FileDiff, VirtualizerContext } from '@pierre/diffs/react'
import { useTranslations } from 'next-intl'
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDiffOptions } from '@/components/agents/file-diff'
import { useViewScroll, useViewState } from '@/lib/hooks/view-state'
import { DIFF_WRAP_KEY, diffWrapFrom, filePatch, splitPath, type ChangedFile, type DiffWrap, type ThreadChanges } from '@/lib/thread-changes'

/**
 * A thread's 改动 tab (Figma 820:4843), read-only: no terminal, no inline
 * comments, nothing to edit. The file list is folded into 「N 个文件 +x −y」
 * until opened; the files follow one after another, each drawn by @pierre/diffs
 * with its header sticking to the top while its lines scroll; long lines wrap
 * unless the person picked 横向滚动.
 */
export function ThreadChangesPane({ changes, stateKey = 'changes' }: { changes: ThreadChanges; stateKey?: string }) {
  const [wrap, setWrap] = useDiffWrap()
  const [filesOpen, setFilesOpen] = useViewState(`${stateKey}:files`, false)
  return <ThreadChangesView stateKey={stateKey} changes={changes} wrap={wrap} onWrapChange={setWrap} filesOpen={filesOpen} onFilesOpenChange={setFilesOpen} />
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

export function ThreadChangesView({ changes, wrap, onWrapChange, filesOpen, onFilesOpenChange, stateKey = 'changes' }: { stateKey?: string;
  changes: ThreadChanges; wrap: DiffWrap; onWrapChange: (next: DiffWrap) => void; filesOpen: boolean; onFilesOpenChange: (open: boolean) => void
}) {
  const t = useTranslations('IssueThreads')
  const listId = useId()
  const sections = useRef(new Map<string, HTMLElement>())
  const [closed, setClosed] = useViewState<string[]>(`${stateKey}:closed-files`, [])
  const scroll = useViewScroll<HTMLDivElement>(stateKey)
  const [virtualizer] = useState(() => typeof window === 'undefined' ? undefined : new Virtualizer())
  useLayoutEffect(() => {
    const node = scroll.current
    if (!node || !virtualizer) return
    virtualizer.setup(node)
    return () => virtualizer.cleanUp()
  }, [scroll, virtualizer])
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
          <span className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground">{dir}</span>
          <Counts additions={file.additions} deletions={file.deletions} />
        </Button>
      </li> })}
    </ul>}
    {/* Only the lines in view are drawn: a change of thousands of lines opens at once. */}
    <VirtualizerContext.Provider value={virtualizer}>
      <div ref={scroll} data-slot="thread-changes-scroll" className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-3">
          {changes.files.map(file => {
            const open = !closed.includes(file.path)
            return <FileSection key={file.path} file={file} open={open} wrap={wrap}
              ref={node => { if (node) sections.current.set(file.path, node); else sections.current.delete(file.path) }}
              onOpenChange={next => setClosed(current => next ? current.filter(path => path !== file.path) : [...current, file.path])} />
          })}
        </div>
      </div>
    </VirtualizerContext.Provider>
  </div>
}

/** 「改动 +128 −34」 on the thread's tab. */
export function ChangesTabLabel({ changes }: { changes: ThreadChanges | null }) {
  const t = useTranslations('IssueThreads')
  return <>{t('changesTab')}{changes && <Counts additions={changes.additions} deletions={changes.deletions} />}</>
}

export function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
    {additions > 0 && <span className="text-success-foreground">+{additions}</span>}
    {deletions > 0 && <span className="text-destructive-foreground">−{deletions}</span>}
  </span>
}

/**
 * The file card sits on the page surface in both themes, not the syntax theme's near-black (UI audit task-06): the theme
 * sets --diffs-bg inside the diff's shadow root, so the override goes there. The official build's token comes first,
 * this repository's after it; the hosted review page does the same (hosted#45).
 */
export const DIFF_SURFACE_CSS = ':host, * { --diffs-bg: var(--color-background-primary-default, var(--background)) !important; }'

/** One changed file as its diff, folded or open; the 改动 tab and the acceptance report draw each file with it. */
export function FileSection({ file, open, wrap, onOpenChange, ref }: { file: ChangedFile; open: boolean; wrap: DiffWrap; onOpenChange: (open: boolean) => void; ref: (node: HTMLElement | null) => void }) {
  const t = useTranslations('IssueThreads')
  const { name } = splitPath(file.path)
  const fileDiff = useMemo(() => getSingularPatch(filePatch(file)), [file])
  // Binary files have no lines to draw: just the header, then the note.
  const base = useDiffOptions({ overflow: wrap, collapsed: !open || file.binary, stickyHeader: true })
  const options = useMemo(() => ({ ...base, unsafeCSS: DIFF_SURFACE_CSS }), [base])
  return <section ref={ref} aria-label={file.path} data-slot="thread-changes-file" className="shrink-0">
    <FileDiff fileDiff={fileDiff} options={options} disableWorkerPool
      renderHeaderPrefix={() => <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-expanded={open} aria-label={t(open ? 'changesCollapseFile' : 'changesExpandFile', { name })} onClick={() => onOpenChange(!open)}>
        {open ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}
      </Button>}
      renderHeaderMetadata={file.url ? () => <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label={t('changesOpenFile')} render={<a href={file.url} target="_blank" rel="noopener noreferrer" />} />}>
        <ExternalLink data-icon="inline-start" />
      </TooltipTrigger><TooltipContent side="bottom">{t('changesOpenFile')}</TooltipContent></Tooltip> : undefined} />
    {open && file.binary && <p className="px-3 py-2 text-xs text-muted-foreground">{t('changesBinary')}</p>}
  </section>
}
