'use client'

import { useMemo, useRef, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { EditorContent, useEditor, type JSONContent } from '@tiptap/react'
import { Extension } from '@tiptap/core'
import { ArrowDown, ArrowUp, Check, History } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { FieldLabel } from '@/components/ui/field'
import { compareDescriptions, descriptionKey } from '@/lib/issue-relations'
import { createEditorExtensions } from './issue-editor'
import { issueIdentifier } from './issue-properties'
import type { listIssueVersions } from '@/app/actions/issues'
import { cn } from '@/lib/utils'

type Version = Awaited<ReturnType<typeof listIssueVersions>>[number]
const HistoryAttributes = Extension.create({
  name: 'historyAttributes',
  addGlobalAttributes: () => [{ types: ['paragraph', 'heading', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'table', 'horizontalRule', 'image'], attributes: {
    historyChange: { default: null, renderHTML: attrs => attrs.historyChange ? { 'data-history-change': attrs.historyChange } : {} },
    historyGroup: { default: null, renderHTML: attrs => attrs.historyGroup ? { 'data-history-group': attrs.historyGroup } : {} },
  } }],
})

function DescriptionPreview({ content }: { content: JSONContent }) {
  const t = useTranslations('IssueDetail.history')
  const extensions = useMemo(() => [...createEditorExtensions(() => false, '', false, true), HistoryAttributes], [])
  const editor = useEditor({ extensions, content, editable: false, immediatelyRender: false, editorProps: { attributes: { 'aria-label': t('previewLabel'), class: 'min-h-72 outline-none prose prose-sm max-w-none break-words text-foreground [&_p]:my-3 [&_h1]:text-2xl [&_h2]:text-xl [&_h3]:text-lg [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_table]:w-full [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2 [&_[data-history-change=added]]:rounded-sm [&_[data-history-change=added]]:bg-info/15 [&_[data-history-change=added]]:text-info-foreground [&_[data-history-change=removed]]:text-muted-foreground [&_[data-history-change=removed]]:line-through' } } })
  return <EditorContent editor={editor} />
}

export function IssueDescriptionHistory({ open, onOpenChange, number, title, currentContent, versions, loadingError, onRetry, onRestore }: {
  open: boolean; onOpenChange: (open: boolean) => void; number?: number; title: string; currentContent: JSONContent; versions?: Version[]; loadingError: boolean; onRetry: () => void; onRestore: (version: Version) => Promise<boolean>
}) {
  const t = useTranslations('IssueDetail.history')
  const tCommon = useTranslations('Common')
  const format = useFormatter()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [highlight, setHighlight] = useState(true)
  const [changeIndex, setChangeIndex] = useState(1)
  const [confirm, setConfirm] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const viewport = useRef<HTMLDivElement>(null)
  const descriptions = useMemo(() => (versions ?? []).filter((version, index, items) => index === items.length - 1 || descriptionKey(version.content) !== descriptionKey(items[index + 1].content)), [versions])
  const selected = descriptions.find(version => version.id === selectedId) ?? descriptions[0]
  const selectedIndex = selected ? descriptions.findIndex(version => version.id === selected.id) : -1
  const previous = descriptions[selectedIndex + 1]?.content ?? { type: 'doc', content: [] }
  const compared = useMemo(() => compareDescriptions(previous, selected?.content ?? currentContent), [previous, selected, currentContent])
  const isCurrent = selected && descriptionKey(selected.content) === descriptionKey(currentContent)
  function jump(offset: number) {
    if (!compared.changes) return
    const next = ((changeIndex - 1 + offset + compared.changes) % compared.changes) + 1
    setChangeIndex(next)
    viewport.current?.querySelector(`[data-history-group="${next}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  async function restore() {
    if (!selected || pending) return
    setConfirm(false); setPending(true); setError('')
    try { if (await onRestore(selected)) onOpenChange(false); else setError(t('restoreIncomplete')) }
    catch { setError(t('restoreFailed')) }
    finally { setPending(false) }
  }
  return <>
    <Dialog open={open} onOpenChange={value => { if (!pending) onOpenChange(value) }}>
      <DialogContent className="flex h-[92svh] max-h-[900px] min-w-0 flex-col gap-0 overflow-hidden p-0 sm:h-[85svh] sm:max-w-[min(90vw,1140px)]">
        <DialogHeader className="shrink-0 px-5 py-4 pr-12"><DialogTitle className="truncate">{t('title', { id: issueIdentifier(number), title })}</DialogTitle><DialogDescription className="sr-only">{t('description')}</DialogDescription></DialogHeader>
        {loadingError ? <div role="alert" className="flex flex-col items-start gap-4 p-6"><p>{t('readFailed')}</p><Button variant="outline" onClick={onRetry}>{t('reload')}</Button></div> : !versions ? <div role="status" aria-label={t('reading')} className="p-6"><Skeleton className="h-72 w-full" /></div> : <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 md:flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border">
            <div ref={viewport} className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-7">
              <div className="mb-5 flex items-center gap-2 text-xs text-muted-foreground"><History className="size-3.5" /><time>{selected ? format.dateTime(new Date(selected.createdAt)) : t('currentDescription')}</time></div>
              <DescriptionPreview key={`${selected?.id ?? 'current'}-${highlight}`} content={highlight ? compared.content : selected?.content ?? currentContent} />
            </div>
            <div className="mx-auto mb-3 flex max-w-full shrink-0 flex-wrap items-center justify-center gap-1 rounded-2xl border bg-popover px-2 py-1 shadow-lg sm:rounded-full [&_button]:min-h-11 [&_button[aria-label]]:min-w-11">
              <FieldLabel className="flex min-h-11 cursor-pointer items-center gap-2 px-1"><Switch size="sm" checked={highlight} onCheckedChange={value => { setHighlight(value); setChangeIndex(1) }} />{t('highlight')}</FieldLabel>
              <span className="px-2 text-xs tabular-nums text-muted-foreground">{compared.changes ? t('changeCounter', { current: Math.min(changeIndex, compared.changes), total: compared.changes }) : t('noChanges')}</span>
              <Button size="icon-xs" variant="ghost" aria-label={t('previousChange')} disabled={!highlight || !compared.changes} onClick={() => jump(-1)}><ArrowUp data-icon="inline-start" /></Button><Button size="icon-xs" variant="ghost" aria-label={t('nextChange')} disabled={!highlight || !compared.changes} onClick={() => jump(1)}><ArrowDown data-icon="inline-start" /></Button>
              <Button size="sm" disabled={!selected || isCurrent || pending} onClick={() => setConfirm(true)}>{pending ? t('restoring') : t('restore')}</Button>
            </div>
            {error && <p role="alert" className="px-4 pb-3 text-xs text-destructive">{error}</p>}
          </div>
          <aside aria-label={t('timeline')} className="order-first flex w-full shrink-0 gap-2 overflow-x-auto p-1 pb-3 md:order-last md:w-56 md:flex-col md:overflow-x-hidden md:overflow-y-auto md:pl-4 md:pr-0">
            {descriptions.length === 0 && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
            {descriptions.map((version, index) => <Button key={version.id} variant={selected?.id === version.id ? 'secondary' : 'ghost'} aria-pressed={selected?.id === version.id} className={cn('h-auto min-h-11 w-40 shrink-0 justify-start whitespace-normal py-3 md:w-full', selected?.id === version.id && 'ring-1 ring-ring')} onClick={() => { setSelectedId(version.id); setChangeIndex(1); setError('') }}><span className="flex w-full flex-col items-start gap-2"><span className="flex w-full items-center justify-between gap-2"><time className="text-xs">{format.dateTime(new Date(version.createdAt), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>{index === 0 && <Badge variant="outline"><Check data-icon="inline-start" />{t('current')}</Badge>}</span><span className="text-xs text-muted-foreground">{t('versionLabel', { revision: version.revision })}</span></span></Button>)}
          </aside>
        </div>}
      </DialogContent>
    </Dialog>
    <AlertDialog open={confirm} onOpenChange={setConfirm}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('confirmTitle')}</AlertDialogTitle><AlertDialogDescription>{t('confirmDescription')}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{tCommon('cancel')}</AlertDialogCancel><AlertDialogAction onClick={() => { void restore() }}>{t('confirmAction')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>
}
