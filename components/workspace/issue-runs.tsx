'use client'

import { useMemo, useState, useSyncExternalStore } from 'react'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import type * as Y from 'yjs'
import { listRuns, type RunView } from '@/app/actions/agents'
import { addThread, createThreadStore } from '@/components/blocks/rich-text-editor-4/components/rich-text-comments'
import { runDiscussionId, runListRefreshInterval, runIsActive, runStatusKey, runDiscussionRunId } from '@/lib/issue-run-conversation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { IssueRunSession } from './issue-run-session'

export function IssueRuns({ issueId, doc, author, authorId }: { issueId: string; doc: Y.Doc; author: string; authorId: string }) {
  const t = useTranslations('IssueRuns')
  const { data, error, mutate } = useSWR(['issue-runs', issueId], () => listRuns(issueId), { refreshInterval: runListRefreshInterval, revalidateOnFocus: true, revalidateOnReconnect: true })
  const sharedStore = useMemo(() => createThreadStore(doc), [doc])
  const sharedThreads = useSyncExternalStore(sharedStore.subscribe, sharedStore.getSnapshot, sharedStore.getSnapshot)
  const ownIds = new Set((data ?? []).map(run => run.id))
  const shared = [...new Set(Object.keys(sharedThreads).map(runDiscussionRunId).filter((id): id is string => id !== null && !ownIds.has(id)))]
  const [opened, setOpened] = useState<string | null>(null)
  return <section aria-label={t('title')} className="flex flex-col gap-4">
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{t('title')}</h3><Button variant="ghost" size="sm" onClick={() => { void mutate() }}>{t('refresh')}</Button></div>
    {error ? <div role="alert"><p>{t('loadFailed')}</p><Button variant="outline" onClick={() => { void mutate() }}>{t('retry')}</Button></div> : !data ? <p role="status">{t('loading')}</p> : !data.length ? <p>{t('empty')}</p> : <>{data.map(run => <RunRecord key={run.id} run={run} runId={run.id} doc={doc} author={author} authorId={authorId} open={opened === run.id} onOpen={() => setOpened(run.id)} />)}<p className="text-xs text-muted-foreground">{t('recentLimit')}</p></>}
    {shared.map(runId => <RunRecord key={runId} runId={runId} doc={doc} author={author} authorId={authorId} open={false} onOpen={() => {}} />)}
    {shared.length > 0 && <p className="text-xs text-muted-foreground">{t('sharedPrivacy')}</p>}
    {opened && <IssueRunSession key={opened} issueId={issueId} runId={opened} onClose={() => setOpened(null)} />}
  </section>
}

function RunRecord({ run, runId, doc, author, authorId, open, onOpen }: { run?: RunView; runId: string; doc: Y.Doc; author: string; authorId: string; open: boolean; onOpen: () => void }) {
  const t = useTranslations('IssueRuns')
  const statusLabel = useTranslations('Coordinator.citation.runStatus')
  const format = useFormatter()
  const [body, setBody] = useState('')
  const [commenting, setCommenting] = useState(false)
  const store = useMemo(() => createThreadStore(doc), [doc])
  const threads = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const id = runDiscussionId(runId)
  const name = run?.agentName ?? t('sharedRun')
  const discussion = Object.values(threads).filter(thread => runDiscussionRunId(thread.id) === runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const thread = discussion[0]
  function comment() {
    const text = body.trim()
    if (!text) return
    const now = new Date().toISOString()
    // Every submission has a unique map key: concurrent first comments cannot replace each other.
    addThread(doc, { id: `${id}:${crypto.randomUUID()}`, author, authorUserId: authorId, createdAt: now, messages: [{ author, authorUserId: authorId, body: text, at: now }] }, 'issue-discussion')
    setBody(''); setCommenting(false)
  }
  return <Card size="sm">
    <CardHeader><CardTitle>{name}</CardTitle><CardDescription>{format.dateTime(new Date(run?.createdAt ?? thread?.createdAt ?? new Date().toISOString()), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">{run && <Badge variant={runIsActive(run.status) ? 'secondary' : 'outline'}>{runStatusKey(run.status) ? statusLabel(runStatusKey(run.status)!) : run.status}</Badge>}{run && <Button variant="outline" size="sm" aria-expanded={open} onClick={onOpen}>{t('open')}</Button>}<Button variant="ghost" size="sm" onClick={() => setCommenting(value => !value)}>{t('comment')}</Button></div>
      {discussion.flatMap(thread => thread.messages).map(message => <div key={message.id}><p className="text-xs font-medium">{message.author}</p><p className="whitespace-pre-wrap break-words text-sm">{message.body}</p></div>)}
      {commenting && <form onSubmit={event => { event.preventDefault(); comment() }} className="flex flex-col gap-2"><FieldGroup><Field><FieldLabel htmlFor={`run-comment-${runId}`}>{t('commentLabel', { agent: name })}</FieldLabel><Textarea id={`run-comment-${runId}`} maxLength={2000} value={body} onChange={event => setBody(event.target.value)} /></Field></FieldGroup><Button type="submit" disabled={!body.trim()}>{t('postComment')}</Button></form>}
    </CardContent>
  </Card>
}
