"use client"

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useEditor, type JSONContent } from "@tiptap/react"
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

export function IssueEditor({ content, onChange }: { content?: JSONContent; onChange: (content: JSONContent) => void }) {
  const [threadDoc] = useState(() => new Y.Doc())
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
    ...createRichTextExtensions({ placeholder: "描述背景与验收标准，输入 / 插入内容…" }),
    RichTextBlockActions,
    RichTextTable,
    RichTextOutlineBlock,
    createRichTextMention([]),
    RichTextSlashCommand.configure({ items: [...RICH_TEXT_BASIC_SLASH_ITEMS, RICH_TEXT_TABLE_SLASH_ITEM, RICH_TEXT_OUTLINE_SLASH_ITEM] }),
    RichTextChanges.configure({ author: "draft-author", tracking: false, now: () => new Date().toISOString() }),
    CommentMark,
    CommentPaint.configure({ isOpen: threadStore.isOpen }),
  ], [threadStore])
  const editor = useEditor({
    extensions,
    content: content ?? EMPTY_DOCUMENT,
    immediatelyRender: false,
    editorProps: { attributes: { role: "textbox", "aria-label": "任务描述", "aria-multiline": "true" } },
    onUpdate: ({ editor: current }) => changeRef.current(current.getJSON()),
  })
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
  useEffect(() => () => { threadStore.destroy(); threadDoc.destroy() }, [threadStore, threadDoc])

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
    addThread(threadDoc, { id, author: "draft-author", createdAt: now, messages: [{ author: "draft-author", body: comment.trim(), at: now }] }, "draft-comment")
    setComment("")
    setCommentError("")
  }
  function submitReply(id: string) {
    if (!reply.trim()) return
    replyToThread(threadDoc, id, { author: "draft-author", body: reply.trim(), at: new Date().toISOString() })
    setReply("")
    setReplyId(null)
  }
  const threadList = Object.values(threads)
  const openCount = threadList.filter(thread => !thread.resolved).length

  return <TooltipProvider delay={300}><section aria-label="任务描述编辑器" className="overflow-hidden rounded-lg border bg-background">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/20 px-3 py-2">
      <span className="flex items-center gap-2 text-xs font-medium"><FileText className="size-3.5 text-muted-foreground" />任务文档<Badge variant="outline">会话草稿</Badge></span>
      <div className="flex items-center gap-2"><NativeSelect aria-label="编辑模式" size="sm" value={mode} onChange={e => setMode(e.target.value)}><NativeSelectOption value="editing">直接编辑</NativeSelectOption><NativeSelectOption value="suggesting">建议修订</NativeSelectOption><NativeSelectOption value="viewing">只读查看</NativeSelectOption></NativeSelect><NativeSelect aria-label="修订显示方式" size="sm" value={markup} onChange={e => setMarkup(e.target.value as RichTextMarkupView)}><NativeSelectOption value="all">全部标记</NativeSelectOption><NativeSelectOption value="final">最终文本</NativeSelectOption><NativeSelectOption value="original">原始文本</NativeSelectOption></NativeSelect></div>
    </div>
    {editable && <FormattingToolbar editor={editor} linkOpen={linkOpen} onLinkOpenChange={setLinkOpen} />}
    <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5" aria-label="文档面板">
      <Button size="sm" variant={panel === "outline" ? "secondary" : "ghost"} onClick={() => setPanel(panel === "outline" ? "" : "outline")}>文档大纲</Button>
      <Button size="sm" variant={panel === "changes" ? "secondary" : "ghost"} onClick={() => setPanel(panel === "changes" ? "" : "changes")}>修订 {changes.length}</Button>
      <Button size="sm" variant={panel === "comments" ? "secondary" : "ghost"} onClick={() => setPanel(panel === "comments" ? "" : "comments")}><MessageSquare data-icon="inline-start" />评论 {openCount}</Button>
      <span className="ml-auto px-1 text-[10px] text-muted-foreground">未接入多人同步</span>
    </div>
    <div className="flex min-h-72 flex-col lg:flex-row">
      <div ref={pageRef} className="relative min-w-0 flex-1">
        <RichTextContent editor={editor} onLinkShortcut={openLink} className={cn("min-h-72 px-9 py-7 text-sm/7 sm:px-12", RICH_TEXT_TABLE_PROSE, RICH_TEXT_MENTION_PROSE, RICH_TEXT_CHANGES_PROSE, RICH_TEXT_COMMENT_PROSE, RICH_TEXT_MARKUP_VIEW[markup])} />
        {editor && <><RichTextFormatBubble editor={editor} linkOpen={linkOpen} onLinkOpenChange={setLinkOpen} /><RichTextLinkBubble editor={editor} onEdit={openLink} /><RichTextTableBubble editor={editor} onDeleteTable={() => setDeleteTableOpen(true)} /><RichTextBlockGutter editor={editor} editable={editable} scrollerRef={pageRef} onDeleteTable={() => setDeleteTableOpen(true)} /></>}
      </div>
      {panel && <aside aria-label={panel === "outline" ? "文档大纲" : panel === "changes" ? "修订审阅" : "文档评论"} className="flex w-full shrink-0 flex-col gap-3 border-t bg-muted/15 p-4 lg:w-60 lg:border-l lg:border-t-0">
        {panel === "outline" && <><h3 className="text-xs font-medium">文档大纲</h3>{outline.length ? outline.map((heading, index) => <button type="button" key={index} className="rounded px-2 py-1 text-left text-xs hover:bg-accent" onClick={() => editor && scrollToRichTextHeading(editor, index)}>{heading.text}</button>) : <p className="text-[11px] leading-6 text-muted-foreground">添加标题后自动生成大纲。输入 / 可插入标题、表格、清单或目录。</p>}</>}
        {panel === "changes" && <><h3 className="text-xs font-medium">修订审阅 · {changes.length}</h3><p className="text-[10px] leading-5 text-muted-foreground">仅跟踪文字增删；格式、表格及块结构修改直接生效。</p>{changes.length === 0 && <p className="text-[11px] leading-6 text-muted-foreground">切换「建议修订」后输入或删除文字，即可接受或拒绝修改。</p>}{changes.map(change => <article key={change.id} className="flex flex-col gap-2 rounded-md border bg-background p-3"><button className="text-left text-[10px] text-muted-foreground" onClick={() => editor?.commands.selectChange(change.id)}>草稿作者 · {change.kind === "insert" ? "新增" : change.kind === "delete" ? "删除" : "替换"}</button>{change.deleted && <del className="break-words text-xs">{change.deleted}</del>}{change.inserted && <ins className="break-words text-xs">{change.inserted}</ins>}<div className="flex gap-1"><Button size="sm" variant="outline" disabled={!editable} onClick={() => editor?.commands.acceptChange(change.id)}><Check data-icon="inline-start" />接受</Button><Button size="sm" variant="ghost" disabled={!editable} onClick={() => editor?.commands.rejectChange(change.id)}><X data-icon="inline-start" />拒绝</Button></div></article>)}</>}
        {panel === "comments" && <><h3 className="text-xs font-medium">选区评论 · {openCount}</h3><p className="text-[10px] leading-5 text-muted-foreground">选中正文后添加评论。评论仅用于当前草稿，不会发送给其他成员。</p><FieldGroup><Field><FieldLabel htmlFor="draft-comment" className="sr-only">评论内容</FieldLabel><Input id="draft-comment" value={comment} onChange={e => setComment(e.target.value)} placeholder="写下评论…" maxLength={2000} disabled={!editable} /></Field></FieldGroup><Button size="sm" variant="outline" disabled={!editable || !comment.trim()} onClick={addComment}>添加选区评论</Button>{commentError && <p role="alert" className="text-xs text-destructive">{commentError}</p>}{threadList.map(thread => { const anchor = anchors.find(item => item.id === thread.id); return <article key={thread.id} className={cn("flex flex-col gap-2 rounded-md border bg-background p-3", activeId === thread.id && "border-primary")}><button className="truncate text-left text-[10px] text-muted-foreground" onClick={() => { if (!editor) return; let start: number | undefined; let end = 0; editor.state.doc.descendants((node, pos) => { if (node.isText && node.marks.some(mark => mark.type.name === "comment" && mark.attrs.id === thread.id)) { start ??= pos; end = pos + node.nodeSize } }); if (start !== undefined) editor.chain().focus().setTextSelection({ from: start, to: end }).run() }}>{anchor?.excerpt ?? "原文已删除"}</button>{thread.messages.map(message => <div key={message.id}><p className="text-[10px] text-muted-foreground">草稿作者</p><p className="break-words text-xs leading-6">{message.body}</p></div>)}<div className="flex gap-1"><Button size="sm" variant="ghost" disabled={!editable} onClick={() => { setReplyId(thread.id); setReply("") }}>回复</Button><Button size="sm" variant="ghost" disabled={!editable} onClick={() => setThreadResolved(threadDoc, thread.id, !thread.resolved)}>{thread.resolved ? "重新打开" : "标记解决"}</Button></div>{thread.resolved && <Badge variant="secondary">已解决</Badge>}{replyId === thread.id && <><Input aria-label="回复评论" placeholder="回复…" value={reply} onChange={e => setReply(e.target.value)} maxLength={2000} /><Button size="sm" disabled={!reply.trim() || !editable} onClick={() => submitReply(thread.id)}>提交回复</Button></>}</article> })}</>}
      </aside>}
    </div>
    <footer className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-[10px] text-muted-foreground"><span>ReUI · Tiptap · 无 AI</span><span>未保存 · 未登录 · 刷新后丢失</span></footer>
    <DeleteTableDialog editor={editor} open={deleteTableOpen} onOpenChange={setDeleteTableOpen} />
  </section></TooltipProvider>
}
