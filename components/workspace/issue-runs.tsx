'use client'

import { useMemo, useState, useSyncExternalStore } from 'react'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { MessageSquare, X } from 'lucide-react'
import type * as Y from 'yjs'
import { listIssueRunSummaries, listRuns, type RunView } from '@/app/actions/agents'
import type { IssueRunSummary } from '@/lib/issue-run-summary'
import { addThread, createThreadStore, type ThreadRecord } from '@/components/blocks/rich-text-editor-4/components/rich-text-comments'
import { runDiscussionId, runListRefreshInterval, runStatusKey, runDiscussionRunId, runSummaryText } from '@/lib/issue-run-conversation'
import { LetterAvatar } from '@/components/nav/letter-avatar'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { RUN_BADGES } from './agent-citations'

type RunRow = IssueRunSummary & { own?: RunView }

/** Agent runs as rows of the Issue's activity, each with its own shared discussion. */
export function IssueRuns({ issueId, doc, author, authorId }: { issueId: string; doc: Y.Doc; author: string; authorId: string }) {
  const t = useTranslations('IssueRuns')
  const { data, error, mutate } = useSWR(['issue-runs', issueId], async () => {
    const [summaries, own] = await Promise.all([listIssueRunSummaries(issueId), listRuns(issueId)])
    const ownById = new Map(own.map(run => [run.id, run]))
    return summaries.map((summary): RunRow => ({ ...summary, own: ownById.get(summary.id) }))
  }, { refreshInterval: runListRefreshInterval, revalidateOnFocus: true, revalidateOnReconnect: true })
  const store = useMemo(() => createThreadStore(doc), [doc])
  const threads = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const discussions = new Map<string, ThreadRecord[]>()
  for (const thread of Object.values(threads)) {
    const runId = runDiscussionRunId(thread.id)
    if (runId) discussions.set(runId, [...discussions.get(runId) ?? [], thread])
  }
  const runs = [...data ?? []].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  const listed = new Set(runs.map(run => run.id))
  // Discussions stay readable after their run leaves the summary (a removed member's run, an older run past the cap).
  const orphaned = data ? [...discussions.keys()].filter(id => !listed.has(id)) : []
  if (error) return <div role="alert" className="flex items-center gap-2 text-xs"><span className="text-destructive">{t('loadFailed')}</span><Button variant="ghost" size="xs" onClick={() => { void mutate() }}>{t('retry')}</Button></div>
  if (!runs.length && !orphaned.length) return null
  return <>
    {runs.map(run => <RunRow key={run.id} runId={run.id} run={run} discussion={discussions.get(run.id) ?? []} doc={doc} author={author} authorId={authorId} />)}
    {orphaned.map(runId => <RunRow key={runId} runId={runId} discussion={discussions.get(runId) ?? []} doc={doc} author={author} authorId={authorId} />)}
  </>
}

function RunRow({ runId, run, discussion, doc, author, authorId }: { runId: string; run?: RunRow; discussion: ThreadRecord[]; doc: Y.Doc; author: string; authorId: string }) {
  const t = useTranslations('IssueRuns')
  const tActivity = useTranslations('Workspace.activity')
  const tCommon = useTranslations('Common')
  const statusLabel = useTranslations('Coordinator.citation.runStatus')
  const format = useFormatter()
  const [replying, setReplying] = useState(false)
  const [body, setBody] = useState('')
  const name = run?.own?.agentName ?? t('agent')
  const status = run && runStatusKey(run.status)
  const summary = run?.own ? runSummaryText(run.own) : null
  const messages = [...discussion].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).flatMap(thread => thread.messages)
  const at = run?.own?.finishedAt ?? run?.createdAt ?? discussion[0]?.createdAt
  function reply() {
    const text = body.trim()
    if (!text) return
    const now = new Date().toISOString()
    // Every submission has a unique map key: concurrent first replies cannot replace each other.
    addThread(doc, { id: `${runDiscussionId(runId)}:${crypto.randomUUID()}`, author, authorUserId: authorId, createdAt: now, messages: [{ author, authorUserId: authorId, body: text, at: now }] }, 'issue-discussion')
    setBody(''); setReplying(false)
  }
  return <article aria-label={t('row', { agent: name })} className="flex gap-3">
    <LetterAvatar name={name} size="search" />
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex min-h-7 flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">{name}</span>
        {run && <Badge variant={RUN_BADGES[run.status] ?? 'secondary'} size="sm">{status ? statusLabel(status) : run.status}</Badge>}
        {at && <time className="text-muted-foreground" dateTime={new Date(at).toISOString()}>{format.dateTime(new Date(at), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>}
      </div>
      {summary && <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm leading-7">{summary}</p>}
      {messages.length > 0 && <div className="flex flex-col gap-2 border-l-2 pl-3">{messages.map(message => <div key={message.id} className="flex flex-col gap-1"><p className="text-xs font-medium">{message.author}</p><p className="whitespace-pre-wrap break-words text-sm leading-7">{message.body}</p></div>)}</div>}
      {replying
        ? <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); reply() }}><FieldGroup><Field><FieldLabel htmlFor={`run-reply-${runId}`} className="sr-only">{t('replyLabel', { agent: name })}</FieldLabel><Textarea id={`run-reply-${runId}`} autoFocus value={body} onChange={event => setBody(event.target.value)} maxLength={2000} placeholder={tActivity('replyPlaceholder')} /></Field></FieldGroup><div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={() => { setReplying(false); setBody('') }}><X data-icon="inline-start" />{tCommon('cancel')}</Button><Button size="sm" type="submit" disabled={!body.trim()}>{tActivity('sendReply')}</Button></div></form>
        : <div className="flex gap-1"><Button type="button" variant="ghost" size="xs" aria-label={t('replyLabel', { agent: name })} onClick={() => setReplying(true)}><MessageSquare data-icon="inline-start" />{tActivity('reply')}</Button></div>}
    </div>
  </article>
}
