'use client'

import { type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowUp } from 'lucide-react'
import type { CommentAnchor, ThreadRecord } from '@/components/blocks/rich-text-editor-4/components/rich-text-comments'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useViewState } from '@/lib/hooks/view-state'
import { commentTree } from '@/lib/comment-thread'
import { CommentRow } from './comment-row'

export function IssueActivity({ issueId, author, viewerId, threads, anchors, events, onComment, onReply, onEdit, onDelete, onResolve, onSelect }: {
  issueId: string
  /** The reader's display name, put in the boxes they write in. */
  author: string
  /** The reader's user id; edit and delete appear only on their own comments. */
  viewerId?: string
  threads: ThreadRecord[]
  anchors: CommentAnchor[]
  events?: ReactNode
  onComment: (body: string) => void
  /** Answers one message; `replyTo` is the message id inside the thread. */
  onReply: (threadId: string, body: string, replyTo?: string) => void
  /** Rewrites one message's body; the server refuses anyone but its author. */
  onEdit?: (threadId: string, messageId: string, body: string) => void
  /** Removes one message; the server refuses anyone but its author. */
  onDelete?: (threadId: string, messageId: string) => void
  onResolve: (id: string, resolved: boolean) => void
  onSelect: (id: string) => void
}) {
  const t = useTranslations('Workspace.activity')
  const drafts = useActivityDrafts(issueId, onComment, onReply)
  const bare = 'field-sizing-content min-h-0 resize-none rounded-none border-none bg-transparent px-0 py-0 shadow-none focus-visible:ring-0 dark:bg-transparent'
  // R-63: comments are bordered cards; events stay plain rows.
  const card = 'overflow-hidden rounded-xl border border-rule bg-card'
  return <section aria-label={t('label')} className="flex flex-col gap-4">
    <h2 className="text-sm font-medium">{t('title')}</h2>
    {events && <div className="flex flex-col gap-3">{events}</div>}
    {[...threads].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(thread => <article key={thread.id} aria-label={t('comment', { author: thread.author })} className={card}>
      {thread.id.startsWith('discussion-') ? null : <div className="px-4 pt-3">
        <Button type="button" variant="ghost" size="xs" className="w-full justify-start border-s-2 ps-2" onClick={() => onSelect(thread.id)}><span className="min-w-0 truncate text-muted-foreground">{anchors.find(anchor => anchor.id === thread.id)?.excerpt ?? t('anchorRemoved')}</span></Button>
      </div>}
      {commentTree(thread).map(node => <CommentRow key={node.message.id} issueId={issueId} node={node} isThreadStart threadResolved={thread.resolved} viewerId={viewerId} viewerName={author}
        editing={drafts.editing} draft={drafts.editDraft} replyingTo={drafts.messageReplyTo} replyDraft={drafts.messageReply} replyPlaceholder={t('replyPlaceholder')}
        onStartReply={drafts.startMessageReply} onReplyDraft={drafts.setMessageReply} onSendReply={() => drafts.sendMessageReply(thread.id)}
        onStartEdit={drafts.startEdit} onEditDraft={drafts.setEditDraft} onSaveEdit={(messageId, body) => { onEdit?.(thread.id, messageId, body); drafts.stopEdit() }} onCancelEdit={drafts.stopEdit}
        onDelete={messageId => onDelete?.(thread.id, messageId)}
        onResolve={() => onResolve(thread.id, !thread.resolved)} />)}
      {!thread.resolved && <form className="flex items-center gap-2 border-t border-rule px-4 py-2.5" onPointerDown={() => { if (drafts.replyTo !== thread.id) { drafts.setReplyTo(thread.id); drafts.setReply('') } }} onSubmit={event => { event.preventDefault(); drafts.sendReply(thread.id) }} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); drafts.sendReply(thread.id) }
      }}>
        <FieldGroup className="min-w-0 flex-1"><Field><FieldLabel htmlFor={`reply-${thread.id}`} className="sr-only">{t('replyLabel')}</FieldLabel>
          <Textarea id={`reply-${thread.id}`} rows={1} value={drafts.replyTo === thread.id ? drafts.reply : ''} onFocus={() => { if (drafts.replyTo !== thread.id) { drafts.setReplyTo(thread.id); drafts.setReply('') } }} onChange={event => { drafts.setReplyTo(thread.id); drafts.setReply(event.target.value) }} maxLength={2000} placeholder={t('replyPlaceholder')} className={bare} />
        </Field></FieldGroup>
        {drafts.replyTo === thread.id && drafts.reply.trim() && <Button type="submit" size="icon-xs" className="rounded-full" aria-label={t('sendReply')}><ArrowUp data-icon="inline-start" /></Button>}
      </form>}
    </article>)}
    <form onSubmit={event => { event.preventDefault(); drafts.submit() }} className={cn(card, 'flex flex-col gap-3 px-4 pt-3 pb-2.5')} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); drafts.submit() }
    }}>
      <FieldGroup><Field><FieldLabel htmlFor="issue-comment" className="sr-only">{t('commentLabel')}</FieldLabel><Textarea id="issue-comment" rows={2} value={drafts.body} onChange={event => drafts.setBody(event.target.value)} placeholder={t('commentPlaceholder')} maxLength={2000} className={cn(bare, 'min-h-10')} /></Field></FieldGroup>
      <div className="flex justify-end"><Button type="submit" size="icon-xs" className="rounded-full" disabled={!drafts.body.trim()} aria-label={t('sendComment')}><ArrowUp data-icon="inline-start" /></Button></div>
    </form>
  </section>
}

/**
 * The comment being written, the reply open on one thread, the reply open on
 * one message, and the message being edited — each kept per task as the page's
 * view state. A reader may have one of each open at once, so editing a message
 * never loses a reply draft and opening a message's reply never loses a
 * thread's.
 */
export function useActivityDrafts(issueId: string, onComment: (body: string) => void, onReply: (threadId: string, body: string, replyTo?: string) => void) {
  const [body, setBody] = useViewState(`task:${issueId}:comment`, '')
  const [replyTo, setReplyTo] = useViewState<string | null>(`task:${issueId}:reply-to`, null)
  const [reply, setReply] = useViewState(`task:${issueId}:reply`, '')
  const [messageReplyTo, setMessageReplyTo] = useViewState<string | null>(`task:${issueId}:message-reply-to`, null)
  const [messageReply, setMessageReply] = useViewState(`task:${issueId}:message-reply`, '')
  const [editing, setEditing] = useViewState<string | null>(`task:${issueId}:editing`, null)
  const [editDraft, setEditDraft] = useViewState(`task:${issueId}:edit`, '')
  function submit() {
    if (!body.trim()) return
    onComment(body.trim())
    setBody('')
  }
  /** The thread-footer box answers the thread itself, as it always has. */
  function sendReply(threadId: string) {
    if (!reply.trim() || replyTo !== threadId) return
    onReply(threadId, reply.trim())
    setReplyTo(null)
    setReply('')
  }
  /** The box under one message answers that message. */
  function startMessageReply(messageId: string) {
    if (messageReplyTo === messageId) { setMessageReplyTo(null); setMessageReply(''); return }
    setMessageReplyTo(messageId)
    setMessageReply('')
  }
  function sendMessageReply(threadId: string) {
    if (!messageReplyTo || !messageReply.trim()) return
    onReply(threadId, messageReply.trim(), messageReplyTo)
    setMessageReplyTo(null)
    setMessageReply('')
  }
  function startEdit(messageId: string, current: string) {
    setEditing(messageId)
    setEditDraft(current)
  }
  function stopEdit() {
    setEditing(null)
    setEditDraft('')
  }
  return { body, setBody, replyTo, setReplyTo, reply, setReply, messageReplyTo, messageReply, setMessageReply, editing, editDraft, setEditDraft, submit, sendReply, startMessageReply, sendMessageReply, startEdit, stopEdit }
}
