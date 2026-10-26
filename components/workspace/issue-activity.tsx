'use client'

import { PersonAvatar } from '@/components/person-avatar'
import { useRef, useState, type ReactNode } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { ArrowUp, Check } from 'lucide-react'
import type { CommentAnchor, ThreadRecord } from '@/components/blocks/rich-text-editor-4/components/rich-text-comments'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

export function IssueActivity({ author, threads, anchors, events, runs, onComment, onReply, onResolve, onSelect }: {
  author: string
  threads: ThreadRecord[]
  anchors: CommentAnchor[]
  events?: ReactNode
  runs?: ReactNode
  onComment: (body: string) => void
  onReply: (id: string, body: string) => void
  onResolve: (id: string, resolved: boolean) => void
  onSelect: (id: string) => void
}) {
  const t = useTranslations('Workspace.activity')
  const format = useFormatter()
  const [body, setBody] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const pressed = useRef<'reply' | 'resolve' | null>(null)
  function submit() {
    if (!body.trim()) return
    onComment(body.trim())
    setBody('')
  }
  // R-63: comments are bordered cards; events stay plain rows.
  const card = 'overflow-hidden rounded-xl border border-rule bg-card'
  const bare = 'field-sizing-content min-h-0 resize-none rounded-none border-none bg-transparent px-0 py-0 shadow-none focus-visible:ring-0 dark:bg-transparent'
  const time = (at: string) => format.dateTime(new Date(at), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  function sendReply(id: string) {
    if (!reply.trim() || replyTo !== id) return
    onReply(id, reply.trim()); setReplyTo(null); setReply('')
  }
  return <section aria-label={t('label')} className="flex flex-col gap-4">
    <h2 className="text-sm font-medium">{t('title')}</h2>
    {(events || runs) && <div className="flex flex-col gap-3">{events}{runs}</div>}
    {[...threads].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(thread => <article key={thread.id} aria-label={t('comment', { author: thread.author })} className={card}>
      {thread.messages.map((message, index) => <div key={message.id} className={cn('flex flex-col gap-1.5 px-4 py-3', index > 0 && 'border-t border-rule')}>
        <div className="flex min-w-0 items-center gap-2">
          <PersonAvatar name={message.author} size="comment" />
          <span className="truncate text-sm font-medium">{message.author}</span>
          <time className="shrink-0 text-xs text-muted-foreground" dateTime={message.at}>{time(message.at)}</time>
          {index === 0 && thread.resolved && <Badge variant="outline">{t('resolved')}</Badge>}
          {index === 0 && <Button type="button" variant="ghost" size="icon-xs" className="ml-auto text-muted-foreground" aria-label={thread.resolved ? t('reopen') : t('resolve')} onPointerDown={event => { pressed.current = 'resolve'; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation() }} onPointerUp={event => { if (pressed.current !== 'resolve') return; pressed.current = null; event.preventDefault(); event.stopPropagation(); onResolve(thread.id, !thread.resolved) }} onClick={event => { event.preventDefault(); event.stopPropagation(); if (event.detail !== 0) return; onResolve(thread.id, !thread.resolved) }}><Check data-icon="inline-start" /></Button>}
        </div>
        {index === 0 && !thread.id.startsWith('discussion-') && <Button type="button" variant="ghost" size="xs" className="w-full justify-start border-l-2 pl-2" onClick={() => onSelect(thread.id)}><span className="min-w-0 truncate text-muted-foreground">{anchors.find(anchor => anchor.id === thread.id)?.excerpt ?? t('anchorRemoved')}</span></Button>}
        <p className="whitespace-pre-wrap break-words text-sm leading-6">{message.body}</p>
      </div>)}
      {!thread.resolved && <form className="flex items-center gap-2 border-t border-rule px-4 py-2.5" onPointerDown={() => { if (replyTo !== thread.id) { setReplyTo(thread.id); setReply('') } }} onSubmit={event => { event.preventDefault(); sendReply(thread.id) }} onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); sendReply(thread.id) } }}>
        <PersonAvatar name={author} size="comment" />
        <FieldGroup className="min-w-0 flex-1"><Field><FieldLabel htmlFor={`reply-${thread.id}`} className="sr-only">{t('replyLabel')}</FieldLabel><Textarea id={`reply-${thread.id}`} rows={1} value={replyTo === thread.id ? reply : ''} onFocus={() => { if (replyTo !== thread.id) { setReplyTo(thread.id); setReply('') } }} onChange={event => { setReplyTo(thread.id); setReply(event.target.value) }} maxLength={2000} placeholder={t('replyPlaceholder')} className={bare} /></Field></FieldGroup>
        {replyTo === thread.id && reply.trim() && <Button type="submit" size="icon-xs" className="rounded-full" aria-label={t('sendReply')}><ArrowUp data-icon="inline-start" /></Button>}
      </form>}
    </article>)}
    <form onSubmit={event => { event.preventDefault(); submit() }} className={cn(card, 'flex flex-col gap-3 px-4 pt-3 pb-2.5')} onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit() } }}>
      <FieldGroup><Field><FieldLabel htmlFor="issue-comment" className="sr-only">{t('commentLabel')}</FieldLabel><Textarea id="issue-comment" rows={2} value={body} onChange={event => setBody(event.target.value)} placeholder={t('commentPlaceholder')} maxLength={2000} className={cn(bare, 'min-h-10')} /></Field></FieldGroup>
      <div className="flex justify-end"><Button type="submit" size="icon-xs" className="rounded-full" disabled={!body.trim()} aria-label={t('sendComment')}><ArrowUp data-icon="inline-start" /></Button></div>
    </form>
  </section>
}
