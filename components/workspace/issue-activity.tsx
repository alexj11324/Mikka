'use client'

import { useState, type ReactNode } from 'react'
import { ArrowUp, Check, MessageSquare, X } from 'lucide-react'
import type { CommentAnchor, ThreadRecord } from '@/components/blocks/rich-text-editor-4/components/rich-text-comments'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'

export function IssueActivity({ author, threads, anchors, events, onComment, onReply, onResolve, onSelect }: {
  author: string
  threads: ThreadRecord[]
  anchors: CommentAnchor[]
  events?: ReactNode
  onComment: (body: string) => void
  onReply: (id: string, body: string) => void
  onResolve: (id: string, resolved: boolean) => void
  onSelect: (id: string) => void
}) {
  const [body, setBody] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  function submit() {
    if (!body.trim()) return
    onComment(body.trim())
    setBody('')
  }
  return <section aria-label="任务活动" className="flex flex-col gap-6">
    <div className="flex items-center gap-2"><h2 className="text-sm font-semibold">活动</h2><span className="text-xs text-muted-foreground">{threads.length ? `${threads.length} 条讨论` : '更新与讨论'}</span></div>
    {events}
    {[...threads].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(thread => <article key={thread.id} className="flex gap-3">
      <Avatar className="size-7 shrink-0"><AvatarFallback>{thread.author.slice(0, 1)}</AvatarFallback></Avatar>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs"><span className="font-medium">{thread.author}</span><time className="text-muted-foreground" dateTime={thread.createdAt}>{new Date(thread.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>{thread.resolved && <Badge variant="outline">已解决</Badge>}</div>
        {!thread.id.startsWith('discussion-') && <div className="border-l-2 pl-3"><Button type="button" variant="ghost" size="xs" className="w-full justify-start pl-0" onClick={() => onSelect(thread.id)}><span className="min-w-0 truncate text-muted-foreground">{anchors.find(anchor => anchor.id === thread.id)?.excerpt ?? '原文已删除'}</span></Button></div>}
        {thread.messages.map((message, index) => <div key={message.id} className="flex flex-col gap-1">{index > 0 && <p className="text-xs font-medium">{message.author}</p>}<p className="whitespace-pre-wrap break-words text-sm leading-7">{message.body}</p></div>)}
        <div className="flex gap-1"><Button variant="ghost" size="xs" onClick={() => { setReplyTo(thread.id); setReply('') }}><MessageSquare data-icon="inline-start" />回复</Button><Button variant="ghost" size="xs" onClick={() => onResolve(thread.id, !thread.resolved)}><Check data-icon="inline-start" />{thread.resolved ? '重新打开' : '解决讨论'}</Button></div>
        {replyTo === thread.id && <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); if (reply.trim()) { onReply(thread.id, reply.trim()); setReplyTo(null); setReply('') } }}><FieldGroup><Field><FieldLabel htmlFor={`reply-${thread.id}`} className="sr-only">回复内容</FieldLabel><Textarea id={`reply-${thread.id}`} value={reply} onChange={event => setReply(event.target.value)} maxLength={2000} placeholder="写下回复…" /></Field></FieldGroup><div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={() => setReplyTo(null)}><X data-icon="inline-start" />取消</Button><Button size="sm" type="submit" disabled={!reply.trim()}>发送回复</Button></div></form>}
      </div>
    </article>)}
    <form onSubmit={event => { event.preventDefault(); submit() }} className="flex gap-3" onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit() } }}>
      <Avatar className="size-7 shrink-0"><AvatarFallback>{author.slice(0, 1)}</AvatarFallback></Avatar>
      <div className="flex min-w-0 flex-1 flex-col gap-2"><FieldGroup><Field><FieldLabel htmlFor="issue-comment" className="sr-only">评论内容</FieldLabel><Textarea id="issue-comment" value={body} onChange={event => setBody(event.target.value)} placeholder="留下评论…" maxLength={2000} /></Field></FieldGroup><div className="flex items-center justify-between gap-2"><span className="text-xs text-muted-foreground">⌘ / Ctrl + Enter 发送</span><Button type="submit" size="icon-sm" disabled={!body.trim()} aria-label="发送评论"><ArrowUp data-icon="inline-start" /></Button></div></div>
    </form>
  </section>
}
