"use client"

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { IssueActivity } from './issue-activity'
import { useEditor, getSchema, type JSONContent } from "@tiptap/react"
import { Collaboration } from "@tiptap/extension-collaboration"
import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap"
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
import { createRichTextExtensions } from "@/components/blocks/rich-text-editor-2/components/rich-text-extensions"
import { RichTextBlockActions } from "@/components/blocks/rich-text-editor-2/components/rich-text-block-actions"
import { RichTextBlockGutter } from "@/components/blocks/rich-text-editor-2/components/rich-text-block-gutter"
import { RichTextFormatBubble, showRichTextFormatBubble } from "@/components/blocks/rich-text-editor-2/components/rich-text-format-bubble"
import { RichTextLinkBubble } from "@/components/blocks/rich-text-editor-2/components/rich-text-link"
import { RichTextSlashCommand, RICH_TEXT_BASIC_SLASH_ITEMS } from "@/components/blocks/rich-text-editor-2/components/rich-text-slash-menu"
import { RichTextOutlineBlock, RICH_TEXT_OUTLINE_SLASH_ITEM } from "@/components/blocks/rich-text-editor-2/components/rich-text-outline-node"
import { useRichTextOutline, scrollToRichTextHeading } from "@/components/blocks/rich-text-editor-2/components/rich-text-outline"
import { RichTextTable, RichTextTableBubble, RICH_TEXT_TABLE_PROSE, RICH_TEXT_TABLE_SLASH_ITEM } from "@/components/blocks/rich-text-editor-2/components/rich-text-table"
import { DeleteTableDialog } from "@/components/blocks/rich-text-editor-2/components/delete-table-dialog"
import { createRichTextMention, RICH_TEXT_MENTION_PROSE } from "@/components/blocks/rich-text-editor-2/components/rich-text-mention"
import { RichTextChanges, useRichTextChanges, RICH_TEXT_CHANGES_PROSE, RICH_TEXT_MARKUP_VIEW, type RichTextMarkupView } from "@/components/blocks/rich-text-editor-3/components/rich-text-changes"
import { CommentMark, CommentPaint, addThread, createThreadStore, replyToThread, setThreadResolved, repaintComments, canAnchorComment, useCommentAnchors, RICH_TEXT_COMMENT_PROSE } from "@/components/blocks/rich-text-editor-4/components/rich-text-comments"

const EMPTY_DOCUMENT: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }
const EMPTY_THREADS: import("@/components/blocks/rich-text-editor-4/components/rich-text-comments").ThreadIndex = {}

function createEditorExtensions(isOpen: (id: string) => boolean, author: string, collaborative: boolean, compact = false) {
  return [
    ...createRichTextExtensions({ placeholder: compact ? '添加描述…' : '描述背景与验收标准，输入 / 插入内容…', collaborative }),
    RichTextBlockActions, RichTextTable, RichTextOutlineBlock, createRichTextMention([]),
    RichTextSlashCommand.configure({ items: [...RICH_TEXT_BASIC_SLASH_ITEMS, RICH_TEXT_TABLE_SLASH_ITEM, RICH_TEXT_OUTLINE_SLASH_ITEM] }),
    RichTextChanges.configure({ author, tracking: false, now: () => new Date().toISOString() }),
    CommentMark, CommentPaint.configure({ isOpen }),
  ]
}
export function createDocumentSeed(content: JSONContent) {
  const schema = getSchema(createEditorExtensions(() => false, 'seed', true))
  const doc = prosemirrorJSONToYDoc(schema, content, 'default')
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}
export function IssueEditor({ content, onChange, sharedDoc, author = '草稿作者', syncLabel = '未保存草稿', replacement, persisted = false, compact = false, layout = 'document', activity }: { content?: JSONContent; onChange: (content: JSONContent) => void; sharedDoc?: Y.Doc; author?: string; syncLabel?: string; replacement?: { content: JSONContent; version: number }; persisted?: boolean; compact?: boolean; layout?: 'document' | 'issue'; activity?: ReactNode }) {
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
  const extensions = useMemo(() => [
    ...createEditorExtensions(threadStore.isOpen, author, !!sharedDoc, compact),
    ...(sharedDoc ? [Collaboration.configure({ document: sharedDoc })] : []),
  ], [threadStore, author, sharedDoc, compact])
  const editor = useEditor({
    extensions,
    content: sharedDoc ? undefined : content ?? EMPTY_DOCUMENT,
    immediatelyRender: false,
    editorProps: { attributes: { role: "textbox", "aria-label": "任务描述", "aria-multiline": "true" } },
    onUpdate: ({ editor: current, transaction }) => {
      if (transaction.docChanged) changeRef.current(current.getJSON())
    },
  })
  useEffect(() => {
    if (!editor || !replacement) return
    const tracking = editor.storage.richTextChanges.tracking
    editor.storage.richTextChanges.tracking = false
    editor.commands.setContent(replacement.content)
    editor.storage.richTextChanges.tracking = tracking
  }, [editor, replacement])
  const { changes } = useRichTextChanges(editor)
  const { anchors, activeId } = useCommentAnchors(editor)
  const outline = useRichTextOutline(editor)
  const editable = mode !== "viewing" && markup === "all"
  useEffect(() => {
    if (!editor) return
    editor.storage.richTextChanges.tracking = mode === "suggesting"
    editor.setEditable(editable)
  }, [editor, mode, editable])
  useEffect(() => { if (editor && !editor.isDestroyed) repaintComments(editor) }, [editor, threads])
  useEffect(() => {
    const observer = () => { if (editor && !editor.isDestroyed) repaintComments(editor) }
    threadDoc.on('update', observer)
    return () => { threadDoc.off('update', observer) }
  }, [threadDoc, editor])

  function openLink() {
    if (!editor?.isEditable) return
    if (editor.isActive("link")) editor.chain().extendMarkRange("link").run()
    showRichTextFormatBubble(editor)
    setLinkOpen(true)
  }
  function addComment() {
    if (!editor || !comment.trim()) return
    if (!canAnchorComment(editor, threadStore.isOpen)) { setCommentError("请先选中一段尚未评论的正文。"); return }
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    if (!editor.chain().setMark("comment", { id }).run()) return
    addThread(threadDoc, { id, author, createdAt: now, messages: [{ author, body: comment.trim(), at: now }] }, "draft-comment")
    setComment("")
    setCommentError("")
  }
  function submitReply(id: string) {
    if (!reply.trim()) return
    replyToThread(threadDoc, id, { author, body: reply.trim(), at: new Date().toISOString() })
    setReply("")
    setReplyId(null)
  }
  const threadList = Object.values(threads)
  const openCount = threadList.filter(thread => !thread.resolved).length

  if (compact) return <TooltipProvider delay={300}><section aria-label="任务描述编辑器">
    <RichTextContent editor={editor} onLinkShortcut={openLink} className={cn("min-h-28", RICH_TEXT_TABLE_PROSE, RICH_TEXT_MENTION_PROSE)} />
    {editor && <><RichTextFormatBubble editor={editor} linkOpen={linkOpen} onLinkOpenChange={setLinkOpen} /><RichTextLinkBubble editor={editor} onEdit={openLink} /><RichTextTableBubble editor={editor} onDeleteTable={() => setDeleteTableOpen(true)} /></>}
    <DeleteTableDialog editor={editor} open={deleteTableOpen} onOpenChange={setDeleteTableOpen} />
  </section></TooltipProvider>

  if (layout === 'issue') return <TooltipProvider delay={300}>
    <section aria-label="任务描述编辑器" className="flex min-w-0 flex-col gap-2">
      <div ref={pageRef} className="relative min-w-0">
        <RichTextContent editor={editor} onLinkShortcut={openLink} className={cn('min-h-36 py-1', RICH_TEXT_TABLE_PROSE, RICH_TEXT_MENTION_PROSE, RICH_TEXT_CHANGES_PROSE, RICH_TEXT_COMMENT_PROSE)} />
        {editor && <><RichTextFormatBubble editor={editor} linkOpen={linkOpen} onLinkOpenChange={setLinkOpen} /><RichTextLinkBubble editor={editor} onEdit={openLink} /><RichTextTableBubble editor={editor} onDeleteTable={() => setDeleteTableOpen(true)} /></>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 pb-7">
        <span className="text-xs text-muted-foreground">输入 / 插入内容，选中文字设置格式</span>
        <Button variant="ghost" size="xs" onClick={() => setPanel(panel === 'comments' ? '' : 'comments')} aria-expanded={panel === 'comments'}><MessageSquare data-icon="inline-start" />选区评论</Button>
      </div>
      {panel === 'comments' && <div className="flex flex-col gap-3 rounded-lg border p-4">
        <p className="text-xs text-muted-foreground">选中描述中的一段文字，再添加评论。</p>
        <FieldGroup><Field><FieldLabel htmlFor="selection-comment" className="sr-only">选区评论内容</FieldLabel><Input id="selection-comment" value={comment} onChange={event => setComment(event.target.value)} maxLength={2000} placeholder="写下选区评论…" /></Field></FieldGroup>
        <div className="flex justify-end"><Button size="sm" variant="outline" disabled={!comment.trim()} onClick={addComment}>添加选区评论</Button></div>
        {commentError && <p role="alert" className="text-xs text-destructive">{commentError}</p>}
      </div>}
    </section>
    <IssueActivity author={author} threads={threadList} anchors={anchors} events={activity} onComment={body => {
      const now = new Date().toISOString()
      addThread(threadDoc, { id: `discussion-${crypto.randomUUID()}`, author, createdAt: now, messages: [{ author, body, at: now }] }, 'issue-discussion')
    }} onReply={(id, body) => { replyToThread(threadDoc, id, { author, body, at: new Date().toISOString() }) }} onResolve={(id, resolved) => { setThreadResolved(threadDoc, id, resolved) }} onSelect={id => {
      if (!editor) return
      let from: number | undefined
      let to = 0
      editor.state.doc.descendants((node, pos) => { if (node.isText && node.marks.some(mark => mark.type.name === 'comment' && mark.attrs.id === id)) { from ??= pos; to = pos + node.nodeSize } })
      if (from !== undefined) editor.chain().focus().setTextSelection({ from, to }).scrollIntoView().run()
    }} />
    <DeleteTableDialog editor={editor} open={deleteTableOpen} onOpenChange={setDeleteTableOpen} />
  </TooltipProvider>

  return <TooltipProvider delay={300}><section aria-label="任务描述编辑器" className="overflow-hidden rounded-lg border bg-background">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/20 px-3 py-2">
      <span className="flex items-center gap-2 text-xs font-medium"><span className="text-muted-foreground"><FileText className="size-3.5" /></span>任务文档<Badge variant="outline">{syncLabel}</Badge></span>
      <div className="flex items-center gap-2"><NativeSelect aria-label="编辑模式" size="sm" value={mode} onChange={e => setMode(e.target.value)}><NativeSelectOption value="editing">直接编辑</NativeSelectOption><NativeSelectOption value="suggesting">建议修订</NativeSelectOption><NativeSelectOption value="viewing">只读查看</NativeSelectOption></NativeSelect><NativeSelect aria-label="修订显示方式" size="sm" value={markup} onChange={e => setMarkup(e.target.value as RichTextMarkupView)}><NativeSelectOption value="all">全部标记</NativeSelectOption><NativeSelectOption value="final">最终文本</NativeSelectOption><NativeSelectOption value="original">原始文本</NativeSelectOption></NativeSelect></div>
    </div>
    {editable && <FormattingToolbar editor={editor} linkOpen={linkOpen} onLinkOpenChange={setLinkOpen} />}
    <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5" aria-label="文档面板">
      <Button size="sm" variant={panel === "outline" ? "secondary" : "ghost"} onClick={() => setPanel(panel === "outline" ? "" : "outline")}>文档大纲</Button>
      <Button size="sm" variant={panel === "changes" ? "secondary" : "ghost"} onClick={() => setPanel(panel === "changes" ? "" : "changes")}>修订 {changes.length}</Button>
      <Button size="sm" variant={panel === "comments" ? "secondary" : "ghost"} onClick={() => setPanel(panel === "comments" ? "" : "comments")}><MessageSquare data-icon="inline-start" />评论 {openCount}</Button>
      <span className="ml-auto px-1 text-xs text-muted-foreground">{persisted ? 'Yjs 合并 · 约 1.5 秒同步' : '创建任务后开启同步'}</span>
    </div>
    <div className="flex min-h-72 flex-col lg:flex-row">
      <div ref={pageRef} className="relative min-w-0 flex-1">
        <RichTextContent editor={editor} onLinkShortcut={openLink} className={cn("min-h-72 px-9 py-7 sm:px-12", RICH_TEXT_TABLE_PROSE, RICH_TEXT_MENTION_PROSE, RICH_TEXT_CHANGES_PROSE, RICH_TEXT_COMMENT_PROSE, RICH_TEXT_MARKUP_VIEW[markup])} />
        {editor && <><RichTextFormatBubble editor={editor} linkOpen={linkOpen} onLinkOpenChange={setLinkOpen} /><RichTextLinkBubble editor={editor} onEdit={openLink} /><RichTextTableBubble editor={editor} onDeleteTable={() => setDeleteTableOpen(true)} /><RichTextBlockGutter editor={editor} editable={editable} scrollerRef={pageRef} onDeleteTable={() => setDeleteTableOpen(true)} /></>}
      </div>
      {panel && <aside aria-label={panel === "outline" ? "文档大纲" : panel === "changes" ? "修订审阅" : "文档评论"} className="flex w-full shrink-0 flex-col gap-3 border-t bg-muted/15 p-4 lg:w-60 lg:border-l lg:border-t-0">
        {panel === "outline" && <><h3 className="text-xs font-medium">文档大纲</h3>{outline.length ? outline.map((heading, index) => <Button key={index} variant="ghost" size="sm" className="justify-start" onClick={() => editor && scrollToRichTextHeading(editor, index)}>{heading.text}</Button>) : <p className="text-xs leading-6 text-muted-foreground">添加标题后自动生成大纲。输入 / 可插入标题、表格、清单或目录。</p>}</>}
        {panel === "changes" && <><h3 className="text-xs font-medium">修订审阅 · {changes.length}</h3><p className="text-xs leading-5 text-muted-foreground">仅跟踪文字增删；格式、表格及块结构修改直接生效。</p>{changes.length === 0 && <p className="text-xs leading-6 text-muted-foreground">切换「建议修订」后输入或删除文字，即可接受或拒绝修改。</p>}{changes.map(change => <article key={change.id} className="flex flex-col gap-2 rounded-md border bg-background p-3"><Button variant="ghost" size="sm" className="justify-start" onClick={() => editor?.commands.selectChange(change.id)}>草稿作者 · {change.kind === "insert" ? "新增" : change.kind === "delete" ? "删除" : "替换"}</Button>{change.deleted && <del className="break-words text-xs">{change.deleted}</del>}{change.inserted && <ins className="break-words text-xs">{change.inserted}</ins>}<div className="flex gap-1"><Button size="sm" variant="outline" disabled={!editable} onClick={() => editor?.commands.acceptChange(change.id)}><Check data-icon="inline-start" />接受</Button><Button size="sm" variant="ghost" disabled={!editable} onClick={() => editor?.commands.rejectChange(change.id)}><X data-icon="inline-start" />拒绝</Button></div></article>)}</>}
        {panel === "comments" && <><h3 className="text-xs font-medium">选区评论 · {openCount}</h3><p className="text-xs leading-5 text-muted-foreground">{persisted ? '选中正文后添加评论，正文与评论一起自动保存并同步给获授权成员。' : '选中正文后添加评论；请先创建任务以启用评论持久化。'}</p><FieldGroup><Field><FieldLabel htmlFor="draft-comment" className="sr-only">评论内容</FieldLabel><Input id="draft-comment" value={comment} onChange={e => setComment(e.target.value)} placeholder="写下评论…" maxLength={2000} disabled={!editable} /></Field></FieldGroup><Button size="sm" variant="outline" disabled={!editable || !comment.trim()} onClick={addComment}>添加选区评论</Button>{commentError && <p role="alert" className="text-xs text-destructive">{commentError}</p>}{threadList.map(thread => { const anchor = anchors.find(item => item.id === thread.id); return <article key={thread.id} className={cn("flex flex-col gap-2 rounded-md border bg-background p-3", activeId === thread.id && "border-primary")}><Button variant="ghost" size="sm" className="justify-start" onClick={() => { if (!editor) return; let start: number | undefined; let end = 0; editor.state.doc.descendants((node, pos) => { if (node.isText && node.marks.some(mark => mark.type.name === "comment" && mark.attrs.id === thread.id)) { start ??= pos; end = pos + node.nodeSize } }); if (start !== undefined) editor.chain().focus().setTextSelection({ from: start, to: end }).run() }}><span className="block truncate">{anchor?.excerpt ?? "原文已删除"}</span></Button>{thread.messages.map(message => <div key={message.id}><p className="text-xs text-muted-foreground">{message.author}</p><p className="break-words text-xs leading-6">{message.body}</p></div>)}<div className="flex gap-1"><Button size="sm" variant="ghost" disabled={!editable} onClick={() => { setReplyId(thread.id); setReply("") }}>回复</Button><Button size="sm" variant="ghost" disabled={!editable} onClick={() => setThreadResolved(threadDoc, thread.id, !thread.resolved)}>{thread.resolved ? "重新打开" : "标记解决"}</Button></div>{thread.resolved && <Badge variant="secondary">已解决</Badge>}{replyId === thread.id && <><Input aria-label="回复评论" placeholder="回复…" value={reply} onChange={e => setReply(e.target.value)} maxLength={2000} /><Button size="sm" disabled={!reply.trim() || !editable} onClick={() => submitReply(thread.id)}>提交回复</Button></>}</article> })}</>}
      </aside>}
    </div>
    <footer className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground"><span>ReUI · Tiptap · 无 AI</span><span>{persisted ? '正文与评论自动保存 · 保存修改创建版本快照' : '创建任务后正文与评论自动同步'}</span></footer>
    <DeleteTableDialog editor={editor} open={deleteTableOpen} onOpenChange={setDeleteTableOpen} />
  </section></TooltipProvider>
}
