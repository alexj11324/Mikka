"use client"

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import type { EditorView } from "@tiptap/pm/view"
import { useTranslations } from "next-intl"
import { IssueActivity } from './issue-activity'
import { useEditor, type JSONContent } from "@tiptap/react"
import { createEditorExtensions, readableIssueContent } from "./issue-editor-schema"
import { TextSelection } from "@tiptap/pm/state"
import { Collaboration } from "@tiptap/extension-collaboration"
import { ySyncPluginKey } from "@tiptap/y-tiptap"
import * as Y from "yjs"
import { Check, FileText, MessageSquare, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { FormattingToolbar } from "@/components/blocks/rich-text-editor-1/components/formatting-toolbar"
import { RichTextContent } from "@/components/blocks/rich-text-editor-2/components/rich-text-content"
import { RichTextBlockGutter } from "@/components/blocks/rich-text-editor-2/components/rich-text-block-gutter"
import { RichTextFormatBubble, showRichTextFormatBubble } from "@/components/blocks/rich-text-editor-2/components/rich-text-format-bubble"
import { RichTextLinkBubble } from "@/components/blocks/rich-text-editor-2/components/rich-text-link"
import { useRichTextOutline, scrollToRichTextHeading } from "@/components/blocks/rich-text-editor-2/components/rich-text-outline"
import { RichTextTableBubble, RICH_TEXT_TABLE_PROSE } from "@/components/blocks/rich-text-editor-2/components/rich-text-table"
import { DeleteTableDialog } from "@/components/blocks/rich-text-editor-2/components/delete-table-dialog"
import { RICH_TEXT_MENTION_PROSE } from "@/components/blocks/rich-text-editor-2/components/rich-text-mention"
import { useRichTextChanges, RICH_TEXT_CHANGES_PROSE, RICH_TEXT_MARKUP_VIEW, type RichTextMarkupView } from "@/components/blocks/rich-text-editor-3/components/rich-text-changes"
import { addThread, createThreadStore, replyToThread, setThreadResolved, bindThreadRepaint, canAnchorComment, useCommentAnchors, RICH_TEXT_COMMENT_PROSE } from "@/components/blocks/rich-text-editor-4/components/rich-text-comments"

const EMPTY_DOCUMENT: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }
const EMPTY_THREADS: import("@/components/blocks/rich-text-editor-4/components/rich-text-comments").ThreadIndex = {}

export { createEditorExtensions, createDocumentSeed } from './issue-editor-schema'
export function IssueEditor({ content, onChange, sharedDoc, author: authorProp, authorId: authorUserId, syncLabel: syncLabelProp, replacement, onReplacementApplied, compact = false, layout = 'document', activity, threadEvents, afterDescription, label: labelProp, disabled = false }: { content?: JSONContent; onChange: (content: JSONContent) => void; sharedDoc?: Y.Doc; author?: string; authorId?: string; syncLabel?: string; replacement?: { content: JSONContent; version: number }; onReplacementApplied?: (success: boolean) => void; persisted?: boolean; compact?: boolean; layout?: 'document' | 'issue' | 'description'; activity?: ReactNode; threadEvents?: ReactNode; afterDescription?: ReactNode; label?: string; disabled?: boolean }) {
  const t = useTranslations('Editor')
  const author = authorProp ?? t('draftAuthor')
  const syncLabel = syncLabelProp ?? t('unsavedDraft')
  const label = labelProp ?? t('descriptionLabel')
  // Without a shared doc the editor renders `content` directly; content the schema rejects stays read-only and is never echoed back.
  const [initialContent] = useState(() => content === undefined ? EMPTY_DOCUMENT : readableIssueContent(content))
  const unreadable = !sharedDoc && initialContent === null
  // Read-only shows no typing hint, including on the empty document that stands in for unreadable content.
  const placeholder = disabled || unreadable ? null : compact ? t('placeholderCompact') : t('placeholderFull')
  const [localDoc] = useState(() => new Y.Doc())
  const threadDoc = sharedDoc ?? localDoc
  const threadStore = useMemo(() => createThreadStore(threadDoc), [threadDoc])
  const threads = useSyncExternalStore(threadStore.subscribe, threadStore.getSnapshot, () => EMPTY_THREADS)
  const [mode, setMode] = useState("editing")
  const [markup, setMarkup] = useState<RichTextMarkupView>("all")
  const [panel, setPanel] = useState("outline")
  const [linkOpen, setLinkOpen] = useState(false)
  const [deleteTableOpen, setDeleteTableOpen] = useState(false)
  const [comment, setComment] = useState("")
  const [reply, setReply] = useState("")
  const [replyId, setReplyId] = useState<string | null>(null)
  const [commentError, setCommentError] = useState("")
  const pageRef = useRef<HTMLDivElement>(null)
  const changeRef = useRef(onChange)
  changeRef.current = onChange
  const replacementCallback = useRef(onReplacementApplied)
  replacementCallback.current = onReplacementApplied
  const extensions = useMemo(() => [
    ...createEditorExtensions(threadStore.isOpen, author, !!sharedDoc, compact, placeholder),
    ...(sharedDoc ? [Collaboration.configure({ document: sharedDoc })] : []),
  ], [threadStore, author, sharedDoc, compact, placeholder])
  // useEditor calls setOptions whenever editorProps is a new object. setOptions
  // re-runs the Yjs binding, so a fresh object on every parent render loops.
  const editorProps = useMemo(() => ({
    attributes: { role: "textbox", "aria-label": label, "aria-multiline": "true" },
    handleKeyDown: (view: EditorView, event: KeyboardEvent) => {
      if (event.key !== "End" || event.shiftKey || event.altKey || !(event.ctrlKey || event.metaKey) || !view.editable) return false
      event.preventDefault()
      try {
        const end = TextSelection.atEnd(view.state.doc)
        if (!view.state.selection.eq(end)) view.dispatch(view.state.tr.setSelection(end).scrollIntoView())
      } catch {
        return false
      }
      return true
    },
  }), [label])
  const editor = useEditor({
    extensions,
    content: sharedDoc ? undefined : initialContent ?? EMPTY_DOCUMENT,
    immediatelyRender: false,
    editorProps,
    onUpdate: ({ editor: current, transaction }) => {
      if (!transaction.docChanged || !current.isFocused) return
      if (transaction.getMeta(ySyncPluginKey)?.isChangeOrigin) return
      changeRef.current(current.getJSON())
    },
  })
  useEffect(() => {
    if (!editor || !replacement) return
    const tracking = editor.storage.richTextChanges.tracking
    editor.storage.richTextChanges.tracking = false
    let applied = false
    try {
      applied = editor.commands.setContent(replacement.content, { emitUpdate: false })
      if (applied && layout !== 'description') changeRef.current(editor.getJSON())
    } catch {
      applied = false
    } finally {
      editor.storage.richTextChanges.tracking = tracking
      replacementCallback.current?.(applied)
    }
  }, [editor, replacement, layout])
  const { changes } = useRichTextChanges(editor)
  const { anchors, activeId } = useCommentAnchors(editor)
  const outline = useRichTextOutline(editor)
  const editable = !disabled && !unreadable && mode !== "viewing" && markup === "all"
  useEffect(() => {
    if (!editor) return
    editor.storage.richTextChanges.tracking = mode === "suggesting"
    editor.setEditable(editable)
  }, [editor, mode, editable])
  useEffect(() => {
    if (!editor) return
    // Thread resolve/reopen does not change the ProseMirror document, so the
    // paint plugin would keep the old highlight. Content updates must not
    // dispatch again: that second transaction crashes Enter, Backspace and Delete.
    return bindThreadRepaint(editor, threadStore.subscribe)
  }, [editor, threadStore])

  function openLink() {
    if (!editor?.isEditable) return
    if (editor.isActive("link")) editor.chain().extendMarkRange("link").run()
    showRichTextFormatBubble(editor)
    setLinkOpen(true)
  }
  function addComment() {
    if (!editor || !comment.trim()) return
    if (!canAnchorComment(editor, threadStore.isOpen)) { setCommentError(t('selectionRequired')); return }
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    if (!editor.chain().setMark("comment", { id }).run()) return
    addThread(threadDoc, { id, author, authorUserId, createdAt: now, messages: [{ author, authorUserId, body: comment.trim(), at: now }] }, "draft-comment")
    setComment("")
    setCommentError("")
  }
  function submitReply(id: string) {
    if (!reply.trim()) return
    replyToThread(threadDoc, id, { author, authorUserId, body: reply.trim(), at: new Date().toISOString() })
    setReply("")
    setReplyId(null)
  }
  const threadList = Object.values(threads)
  const openCount = threadList.filter(thread => !thread.resolved).length

  if (compact || layout === 'description' || layout === 'issue') return <TooltipProvider delay={300}>
    <section aria-label={t('editorAria', { label })} className="flex min-w-0 flex-col gap-2">
      <div className={cn('min-w-0 [--frame-panel-header-px:--spacing(2)] [--frame-panel-header-py:--spacing(2)]', layout === 'description' ? '[&>[role=toolbar]]:rounded-lg [&>[role=toolbar]]:border' : layout === 'issue' ? '' : 'rounded-lg border')}>
        {layout !== 'issue' && <FormattingToolbar editor={editor} linkOpen={linkOpen} onLinkOpenChange={setLinkOpen} />}
        <div ref={pageRef} className="relative min-w-0">
          <RichTextContent editor={editor} onLinkShortcut={openLink} className={cn('min-h-28 py-2 text-sm/7', layout === 'description' ? 'px-4 sm:pl-16' : layout === 'issue' ? 'px-0' : 'px-4 sm:px-10', RICH_TEXT_TABLE_PROSE, RICH_TEXT_MENTION_PROSE, RICH_TEXT_CHANGES_PROSE, RICH_TEXT_COMMENT_PROSE)} />
          {editor && <><RichTextFormatBubble editor={editor} linkOpen={linkOpen} onLinkOpenChange={setLinkOpen} /><RichTextLinkBubble editor={editor} onEdit={openLink} /><RichTextTableBubble editor={editor} onDeleteTable={() => setDeleteTableOpen(true)} /><RichTextBlockGutter editor={editor} editable={editable} scrollerRef={pageRef} gap={layout === 'description' ? 12 : undefined} onDeleteTable={() => setDeleteTableOpen(true)} /></>}
        </div>
      </div>
      {layout === 'issue' && !compact && <><div className="flex justify-end pb-2">
        <Button variant="ghost" size="xs" onClick={() => setPanel(panel === 'comments' ? '' : 'comments')} aria-expanded={panel === 'comments'}><MessageSquare data-icon="inline-start" />{t('selectionComment')}</Button>
      </div>
      {panel === 'comments' && <div className="flex flex-col gap-3 rounded-lg border p-4">
        <FieldGroup><Field><FieldLabel htmlFor="selection-comment" className="sr-only">{t('selectionCommentLabel')}</FieldLabel><Input id="selection-comment" value={comment} onChange={event => setComment(event.target.value)} maxLength={2000} placeholder={t('selectionCommentPlaceholder')} /></Field></FieldGroup>
        <div className="flex justify-end"><Button size="sm" variant="outline" disabled={!comment.trim()} onClick={addComment}>{t('addSelectionComment')}</Button></div>
        {commentError && <p role="alert" className="text-xs text-destructive">{commentError}</p>}
      </div>}</>}
    </section>
    {layout === 'issue' && !compact && afterDescription}
    {layout === 'issue' && !compact && <IssueActivity author={author} threads={threadList} anchors={anchors} events={activity} runs={threadEvents} onComment={body => {
      const now = new Date().toISOString()
      addThread(threadDoc, { id: `discussion-${crypto.randomUUID()}`, author, authorUserId, createdAt: now, messages: [{ author, authorUserId, body, at: now }] }, 'issue-discussion')
    }} onReply={(id, body) => { replyToThread(threadDoc, id, { author, authorUserId, body, at: new Date().toISOString() }) }} onResolve={(id, resolved) => { setThreadResolved(threadDoc, id, resolved) }} onSelect={id => {
      if (!editor) return
      let from: number | undefined
      let to = 0
      editor.state.doc.descendants((node, pos) => { if (node.isText && node.marks.some(mark => mark.type.name === 'comment' && mark.attrs.id === id)) { from ??= pos; to = pos + node.nodeSize } })
      if (from !== undefined) editor.chain().focus().setTextSelection({ from, to }).scrollIntoView().run()
    }} />}
    <DeleteTableDialog editor={editor} open={deleteTableOpen} onOpenChange={setDeleteTableOpen} />
  </TooltipProvider>

  return <TooltipProvider delay={300}><section aria-label={t('editorAria', { label: t('descriptionLabel') })} className="overflow-hidden rounded-lg border bg-background">
    <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/20 px-3 py-2">
      <span className="flex items-center gap-2 text-xs font-medium"><FileText className="size-3.5 text-muted-foreground" />{t('document')}{syncLabel && <Badge variant="outline">{syncLabel}</Badge>}</span>
      <div className="flex items-center gap-2"><NativeSelect aria-label={t('editMode')} size="sm" value={mode} onChange={e => setMode(e.target.value)}><NativeSelectOption value="editing">{t('mode.editing')}</NativeSelectOption><NativeSelectOption value="suggesting">{t('mode.suggesting')}</NativeSelectOption><NativeSelectOption value="viewing">{t('mode.viewing')}</NativeSelectOption></NativeSelect><NativeSelect aria-label={t('markupView')} size="sm" value={markup} onChange={e => setMarkup(e.target.value as RichTextMarkupView)}><NativeSelectOption value="all">{t('markup.all')}</NativeSelectOption><NativeSelectOption value="final">{t('markup.final')}</NativeSelectOption><NativeSelectOption value="original">{t('markup.original')}</NativeSelectOption></NativeSelect></div>
    </div>
    {editable && <FormattingToolbar editor={editor} linkOpen={linkOpen} onLinkOpenChange={setLinkOpen} />}
    <div className="flex flex-wrap items-center gap-1 px-2 py-1.5" aria-label={t('panels')}>
      <Button size="sm" variant={panel === "outline" ? "secondary" : "ghost"} onClick={() => setPanel(panel === "outline" ? "" : "outline")}>{t('outline')}</Button>
      <Button size="sm" variant={panel === "changes" ? "secondary" : "ghost"} onClick={() => setPanel(panel === "changes" ? "" : "changes")}>{t('changes', { count: changes.length })}</Button>
      <Button size="sm" variant={panel === "comments" ? "secondary" : "ghost"} onClick={() => setPanel(panel === "comments" ? "" : "comments")}><MessageSquare data-icon="inline-start" />{t('comments', { count: openCount })}</Button>
    </div>
    <div className="flex min-h-72 flex-col lg:flex-row">
      <div ref={pageRef} className="relative min-w-0 flex-1">
        <RichTextContent editor={editor} onLinkShortcut={openLink} className={cn("min-h-72 px-9 py-7 text-sm/7 sm:px-12", RICH_TEXT_TABLE_PROSE, RICH_TEXT_MENTION_PROSE, RICH_TEXT_CHANGES_PROSE, RICH_TEXT_COMMENT_PROSE, RICH_TEXT_MARKUP_VIEW[markup])} />
        {editor && <><RichTextFormatBubble editor={editor} linkOpen={linkOpen} onLinkOpenChange={setLinkOpen} /><RichTextLinkBubble editor={editor} onEdit={openLink} /><RichTextTableBubble editor={editor} onDeleteTable={() => setDeleteTableOpen(true)} /><RichTextBlockGutter editor={editor} editable={editable} scrollerRef={pageRef} onDeleteTable={() => setDeleteTableOpen(true)} /></>}
      </div>
      {panel && <aside aria-label={panel === "outline" ? t('outline') : panel === "changes" ? t('changesReview') : t('commentsPanel')} className="flex w-full shrink-0 flex-col gap-3 bg-muted/15 p-4 lg:w-60 lg:border-l">
        {panel === "outline" && <><h3 className="text-xs font-medium">{t('outline')}</h3>{outline.length ? outline.map((heading, index) => <Button key={index} variant="ghost" size="sm" className="justify-start" onClick={() => editor && scrollToRichTextHeading(editor, index)}>{heading.text}</Button>) : null}</>}
        {panel === "changes" && <><h3 className="text-xs font-medium">{t('changesReviewCount', { count: changes.length })}</h3>{changes.map(change => <article key={change.id} className="flex flex-col gap-2 rounded-md bg-background p-3"><Button variant="ghost" size="sm" className="justify-start" onClick={() => editor?.commands.selectChange(change.id)}>{t('changeSummary', { author: t('draftAuthor'), kind: change.kind === "insert" ? t('changeKind.insert') : change.kind === "delete" ? t('changeKind.delete') : t('changeKind.replace') })}</Button>{change.deleted && <del className="break-words text-xs">{change.deleted}</del>}{change.inserted && <ins className="break-words text-xs">{change.inserted}</ins>}<div className="flex gap-1"><Button size="sm" variant="outline" disabled={!editable} onClick={() => editor?.commands.acceptChange(change.id)}><Check data-icon="inline-start" />{t('accept')}</Button><Button size="sm" variant="ghost" disabled={!editable} onClick={() => editor?.commands.rejectChange(change.id)}><X data-icon="inline-start" />{t('reject')}</Button></div></article>)}</>}
        {panel === "comments" && <><h3 className="text-xs font-medium">{t('commentsPanelCount', { count: openCount })}</h3><FieldGroup><Field><FieldLabel htmlFor="draft-comment" className="sr-only">{t('commentLabel')}</FieldLabel><Input id="draft-comment" value={comment} onChange={e => setComment(e.target.value)} placeholder={t('commentPlaceholder')} maxLength={2000} disabled={!editable} /></Field></FieldGroup><Button size="sm" variant="outline" disabled={!editable || !comment.trim()} onClick={addComment}>{t('addSelectionComment')}</Button>{commentError && <p role="alert" className="text-xs text-destructive">{commentError}</p>}{threadList.map(thread => { const anchor = anchors.find(item => item.id === thread.id); return <article key={thread.id} className={cn("flex flex-col gap-2 rounded-md bg-background p-3", activeId === thread.id && "ring-1 ring-primary")}><Button variant="ghost" size="sm" className="justify-start" onClick={() => { if (!editor) return; let start: number | undefined; let end = 0; editor.state.doc.descendants((node, pos) => { if (node.isText && node.marks.some(mark => mark.type.name === "comment" && mark.attrs.id === thread.id)) { start ??= pos; end = pos + node.nodeSize } }); if (start !== undefined) editor.chain().focus().setTextSelection({ from: start, to: end }).run() }}><span className="block truncate">{anchor?.excerpt ?? t('anchorRemoved')}</span></Button>{thread.messages.map(message => <div key={message.id}><p className="text-xs text-muted-foreground">{message.author}</p><p className="break-words text-xs leading-6">{message.body}</p></div>)}<div className="flex gap-1"><Button size="sm" variant="ghost" disabled={!editable} onClick={() => { setReplyId(thread.id); setReply("") }}>{t('reply')}</Button><Button size="sm" variant="ghost" disabled={!editable} onClick={() => setThreadResolved(threadDoc, thread.id, !thread.resolved)}>{thread.resolved ? t('reopen') : t('resolve')}</Button></div>{thread.resolved && <Badge variant="secondary">{t('resolved')}</Badge>}{replyId === thread.id && <><Input aria-label={t('replyLabel')} placeholder={t('replyPlaceholder')} value={reply} onChange={e => setReply(e.target.value)} maxLength={2000} /><Button size="sm" disabled={!reply.trim() || !editable} onClick={() => submitReply(thread.id)}>{t('submitReply')}</Button></>}</article> })}</>}
      </aside>}
    </div>
    <DeleteTableDialog editor={editor} open={deleteTableOpen} onOpenChange={setDeleteTableOpen} />
  </section></TooltipProvider>
}
