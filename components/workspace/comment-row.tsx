'use client'

import { useRef } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { ArrowUp, Check, Paperclip, Pencil, Trash2 } from 'lucide-react'
import { PersonAvatar } from '@/components/person-avatar'
import type { CommentAttachment, ThreadMessage } from '@/components/blocks/rich-text-editor-4/components/rich-text-comments'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { attachmentsOf, isTombstone, mayEditMessage, type CommentNode } from '@/lib/comment-thread'

/** A file on a comment: its name and size; a click opens the issue's own download. */
function AttachmentRow({ issueId, file }: { issueId: string; file: CommentAttachment }) {
  const t = useTranslations('Workspace.activity')
  return <a href={`/api/issues/${issueId}/files/${file.id}`} className="flex w-fit max-w-full items-center gap-1.5 rounded-md border border-rule px-2 py-1 text-xs text-muted-foreground hover:bg-muted" download={file.name}>
    <Paperclip className="size-3 shrink-0" aria-hidden="true" />
    <span className="min-w-0 truncate">{file.name}</span>
    <span className="shrink-0" aria-hidden="true">{file.size}</span>
    <span className="sr-only">{t('downloadFile', { name: file.name })}</span>
  </a>
}

/** Who wrote it, when, and (for an edit) that the words changed since. */
function CommentHeader({ message, showResolved, threadResolved, onResolve, indent }: { message: ThreadMessage; showResolved: boolean; threadResolved: boolean; onResolve?: () => void; indent: number }) {
  const t = useTranslations('Workspace.activity')
  const format = useFormatter()
  const pressed = useRef(false)
  const time = format.dateTime(new Date(message.at), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return <div className="flex min-w-0 items-center gap-2">
    <PersonAvatar name={message.author} size={indent > 0 ? 'row' : 'comment'} />
    <span className={cn('truncate font-medium', indent > 0 ? 'text-xs' : 'text-sm')}>{message.author}</span>
    <time className="shrink-0 text-xs text-muted-foreground" dateTime={message.at}>{time}</time>
    {message.editedAt && <span className="shrink-0 text-xs text-muted-foreground">{t('edited')}</span>}
    {showResolved && threadResolved && <Badge variant="outline">{t('resolved')}</Badge>}
    {onResolve && <Button type="button" variant="ghost" size="icon-xs" className="ml-auto text-muted-foreground" aria-label={threadResolved ? t('reopen') : t('resolve')}
      onPointerDown={event => { pressed.current = true; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation() }}
      onPointerUp={event => { if (!pressed.current) return; pressed.current = false; event.preventDefault(); event.stopPropagation(); onResolve() }}
      onClick={event => { event.preventDefault(); event.stopPropagation(); if (event.detail !== 0) return; onResolve() }}><Check data-icon="inline-start" /></Button>}
  </div>
}

/** The field the author edits their message in; Enter sends, Escape and 取消 leave it alone. */
function EditField({ value, onChange, onSave, onCancel, label }: { value: string; onChange: (value: string) => void; onSave: () => void; onCancel: () => void; label: string }) {
  const t = useTranslations('Workspace.activity')
  return <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); onSave() }} onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.key === 'Escape') { event.preventDefault(); onCancel() }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onSave() }
  }}>
    <FieldGroup><Field><FieldLabel htmlFor={`edit-${label}`} className="sr-only">{t('editLabel')}</FieldLabel>
      <Textarea id={`edit-${label}`} rows={2} value={value} onChange={event => onChange(event.target.value)} maxLength={2000} />
    </Field></FieldGroup>
    <div className="flex justify-end gap-2">
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>{t('cancelEdit')}</Button>
      <Button type="submit" size="sm" variant="outline" disabled={!value.trim()}>{t('saveEdit')}</Button>
    </div>
  </form>
}

export type CommentRowProps = {
  issueId: string
  node: CommentNode
  /** The thread's first message draws its own resolve control and anchor. */
  isThreadStart: boolean
  threadResolved: boolean
  /** Who is reading; edit and delete appear only for their own messages. */
  viewerId?: string
  /** The reader's display name, shown in the reply box they are about to write in. */
  viewerName: string
  editing: string | null
  draft: string
  /** The message being answered by the quick reply box, if any. */
  replyingTo: string | null
  replyDraft: string
  replyPlaceholder: string
  onStartReply: (messageId: string) => void
  onReplyDraft: (body: string) => void
  onSendReply: () => void
  onStartEdit: (messageId: string, body: string) => void
  onEditDraft: (body: string) => void
  onSaveEdit: (messageId: string, body: string) => void
  onCancelEdit: () => void
  onDelete: (messageId: string) => void
  onResolve?: () => void
}

/**
 * One comment and its replies. A reply indents by depth so a conversation that
 * answers an answer reads as one thread; the indent stops widening after two
 * levels so a long exchange stays readable in a narrow column.
 */
export function CommentRow({ issueId, node, isThreadStart, threadResolved, viewerId, viewerName, editing, draft, replyingTo, replyDraft, replyPlaceholder, onStartReply, onReplyDraft, onSendReply, onStartEdit, onEditDraft, onSaveEdit, onCancelEdit, onDelete, onResolve }: CommentRowProps) {
  const t = useTranslations('Workspace.activity')
  const { message, depth } = node
  const canEdit = mayEditMessage(message, viewerId)
  const files = attachmentsOf(message)
  const replyOpen = replyingTo === message.id
  const nested = { issueId, isThreadStart: false, threadResolved, viewerId, viewerName, editing, draft, replyingTo, replyDraft, replyPlaceholder, onStartReply, onReplyDraft, onSendReply, onStartEdit, onEditDraft, onSaveEdit, onCancelEdit, onDelete }
  // Depth reads as indentation and a tinted surface, never a drawn line: a
  // reply nests inside a bordered box so a long exchange stays legible.
  return <>
    <div className={cn('flex flex-col gap-1.5 px-4 py-3', depth > 0 && 'ps-3')}>
      <div className={cn('flex flex-col gap-1.5', depth >= 1 && 'rounded-lg bg-muted/40 p-2.5', depth >= 2 && 'ps-2.5')}>
        <CommentHeader message={message} showResolved={isThreadStart} threadResolved={threadResolved} onResolve={isThreadStart ? onResolve : undefined} indent={depth} />
        {/* A message the author removed keeps its place so the replies below it still have a parent. */}
        {isTombstone(message) ? <p className="text-sm text-muted-foreground italic">{t('deletedComment', { author: message.author })}</p> : editing === message.id
          ? <EditField value={draft} onChange={onEditDraft} label={message.id} onSave={() => { if (draft.trim()) onSaveEdit(message.id, draft.trim()) }} onCancel={onCancelEdit} />
          : <>
            <p className="whitespace-pre-wrap break-words text-md">{message.body}</p>
            {files.length > 0 && <div className="flex flex-wrap gap-1.5">{files.map(file => <AttachmentRow key={file.id} issueId={issueId} file={file} />)}</div>}
            <div className="flex items-center gap-1">
              <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" aria-expanded={replyOpen} onClick={() => onStartReply(message.id)}>{t('reply')}</Button>
              {canEdit && <>
                <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label={t('editComment', { author: message.author })} onClick={() => onStartEdit(message.id, message.body)}><Pencil aria-hidden="true" /></Button>
                <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label={t('deleteComment', { author: message.author })} onClick={() => onDelete(message.id)}><Trash2 aria-hidden="true" /></Button>
              </>}
            </div>
          </>}
        {replyOpen && <ReplyField id={message.id} author={viewerName} value={replyDraft} onChange={onReplyDraft} onSend={onSendReply} placeholder={replyPlaceholder} />}
      </div>
    </div>
    {node.replies.map(reply => <CommentRow key={reply.message.id} node={reply} {...nested} />)}
  </>
}

/** The box that answers one comment; it sits under the message it answers, not at the thread's foot. */
export function ReplyField({ id, author, value, onChange, onSend, placeholder }: { id: string; author: string; value: string; onChange: (value: string) => void; onSend: () => void; placeholder: string }) {
  const t = useTranslations('Workspace.activity')
  const bare = 'field-sizing-content min-h-0 resize-none rounded-none border-none bg-transparent px-0 py-0 shadow-none focus-visible:ring-0 dark:bg-transparent'
  return <form className="flex items-center gap-2 rounded-lg bg-muted/40 px-2 py-1.5" onSubmit={event => { event.preventDefault(); onSend() }} onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onSend() }
  }}>
    <PersonAvatar name={author} size="comment" />
    <FieldGroup className="min-w-0 flex-1"><Field><FieldLabel htmlFor={`reply-${id}`} className="sr-only">{t('replyLabel')}</FieldLabel>
      <Textarea id={`reply-${id}`} rows={1} value={value} onChange={event => onChange(event.target.value)} maxLength={2000} placeholder={placeholder} className={bare} />
    </Field></FieldGroup>
    {value.trim() && <Button type="submit" size="icon-xs" className="rounded-full" aria-label={t('sendReply')}><ArrowUp data-icon="inline-start" /></Button>}
  </form>
}
