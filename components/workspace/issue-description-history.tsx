'use client'

import { useMemo, useRef, useState } from 'react'
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
  const extensions = useMemo(() => [...createEditorExtensions(() => false, '', false, true), HistoryAttributes], [])
  const editor = useEditor({ extensions, content, editable: false, immediatelyRender: false, editorProps: { attributes: { 'aria-label': '历史描述预览', class: 'min-h-72 outline-none prose prose-sm max-w-none break-words text-foreground [&_p]:my-3 [&_h1]:text-2xl [&_h2]:text-xl [&_h3]:text-lg [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_table]:w-full [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2 [&_[data-history-change=added]]:rounded-sm [&_[data-history-change=added]]:bg-info/15 [&_[data-history-change=added]]:text-info-foreground [&_[data-history-change=removed]]:text-muted-foreground [&_[data-history-change=removed]]:line-through' } } })
  return <EditorContent editor={editor} />
}

export function IssueDescriptionHistory({ open, onOpenChange, number, title, currentContent, versions, loadingError, onRetry, onRestore }: {
  open: boolean; onOpenChange: (open: boolean) => void; number?: number; title: string; currentContent: JSONContent; versions?: Version[]; loadingError: boolean; onRetry: () => void; onRestore: (version: Version) => Promise<boolean>
}) {
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
    try { if (await onRestore(selected)) onOpenChange(false); else setError('恢复未完成，当前描述未被丢弃，请重试。') }
    catch { setError('恢复失败，请重试。') }
    finally { setPending(false) }
  }
  return <>
    <Dialog open={open} onOpenChange={value => { if (!pending) onOpenChange(value) }}>
      <DialogContent className="flex h-[85svh] max-h-[900px] flex-col gap-0 p-0 sm:max-w-[min(90vw,1140px)]">
        <DialogHeader className="shrink-0 px-5 py-4 pr-12"><DialogTitle className="truncate">{issueIdentifier(number)} {title} 的描述历史</DialogTitle><DialogDescription className="sr-only">左侧预览描述与变更，右侧选择历史版本。恢复仅替换描述，不修改当前标题、属性与评论。</DialogDescription></DialogHeader>
        {loadingError ? <div role="alert" className="flex flex-col items-start gap-4 p-6"><p>描述历史读取失败。</p><Button variant="outline" onClick={onRetry}>重新加载</Button></div> : !versions ? <div role="status" aria-label="正在读取描述历史" className="p-6"><Skeleton className="h-72 w-full" /></div> : <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 md:flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border">
            <div ref={viewport} className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-7">
              <div className="mb-5 flex items-center gap-2 text-xs text-muted-foreground"><History className="size-3.5" /><time>{selected ? new Date(selected.createdAt).toLocaleString('zh-CN') : '当前描述'}</time></div>
              <DescriptionPreview key={`${selected?.id ?? 'current'}-${highlight}`} content={highlight ? compared.content : selected?.content ?? currentContent} />
            </div>
            <div className="sticky bottom-0 flex flex-wrap items-center justify-center gap-2 bg-muted/40 px-3 py-3">
              <FieldLabel className="flex cursor-pointer items-center gap-2"><Switch size="sm" checked={highlight} onCheckedChange={value => { setHighlight(value); setChangeIndex(1) }} />高亮变更</FieldLabel>
              <span className="px-2 text-xs tabular-nums text-muted-foreground">{compared.changes ? `${Math.min(changeIndex, compared.changes)} / ${compared.changes}` : '无描述变更'}</span>
              <Button size="icon-xs" variant="ghost" aria-label="上一处变更" disabled={!highlight || !compared.changes} onClick={() => jump(-1)}><ArrowUp data-icon="inline-start" /></Button><Button size="icon-xs" variant="ghost" aria-label="下一处变更" disabled={!highlight || !compared.changes} onClick={() => jump(1)}><ArrowDown data-icon="inline-start" /></Button>
              <Button size="sm" disabled={!selected || isCurrent || pending} onClick={() => setConfirm(true)}>{pending ? '正在恢复…' : '恢复此描述'}</Button>
            </div>
            {error && <p role="alert" className="px-4 pb-3 text-xs text-destructive">{error}</p>}
          </div>
          <aside aria-label="描述版本时间线" className="flex max-h-40 w-full shrink-0 flex-col gap-2 overflow-y-auto p-3 md:max-h-none md:w-56 md:pl-4 md:pr-0">
            {descriptions.length === 0 && <p className="text-sm text-muted-foreground">暂无描述历史。</p>}
            {descriptions.map((version, index) => <Button key={version.id} variant={selected?.id === version.id ? 'secondary' : 'ghost'} className={cn('h-auto w-full justify-start whitespace-normal py-3', selected?.id === version.id && 'ring-1 ring-ring')} onClick={() => { setSelectedId(version.id); setChangeIndex(1); setError('') }}><span className="flex w-full flex-col items-start gap-2"><span className="flex w-full items-center justify-between gap-2"><time className="text-xs">{new Date(version.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>{index === 0 && <Badge variant="outline"><Check data-icon="inline-start" />当前</Badge>}</span><span className="text-xs text-muted-foreground">描述版本 · v{version.revision}</span></span></Button>)}
          </aside>
        </div>}
      </DialogContent>
    </Dialog>
    <AlertDialog open={confirm} onOpenChange={setConfirm}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>恢复此描述？</AlertDialogTitle><AlertDialogDescription>当前描述将被所选版本替换，并保存为新版本。标题、状态、任务属性及现有评论会保留。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => { void restore() }}>确认恢复描述</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>
}
