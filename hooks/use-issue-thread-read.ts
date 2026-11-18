'use client'

import useSWR, { unstable_serialize, useSWRConfig } from 'swr'
import { getIssueThread, type IssueThreadDetail } from '@/app/actions/agents'
import { mergeThreadChunks } from '@/lib/issue-run-conversation'

export function useIssueThreadRead(issueId: string | null, runId: string | null) {
  const { cache } = useSWRConfig()
  return useSWR(runId ? ['issue-thread', issueId, runId] as const : null, async key => {
    const [, issue, run] = key
    const held = cache.get(unstable_serialize(key))?.data as IssueThreadDetail | undefined
    const page = held?.historyPage
    const read = await getIssueThread(issue, run, held?.chunkCursor ?? {
      kind: 'history',
      ...(page?.latest ? { after: { chain: page.chain, count: page.count, position: page.latest } } : {}),
    })
    if (!page || !read.historyPage?.append || !held) return mergeThreadChunks(held, read)
    const { messageUpdates, ...merged } = mergeThreadChunks(held, { ...read, chunksAppend: true })
    const updated = new Map(messageUpdates?.map(message => [message.id, message]))
    return {
      ...merged,
      chunksAppend: false,
      messages: [...held.messages.map(message => updated.get(message.id) ?? message), ...read.messages],
      historyPage: { ...read.historyPage, before: page.before },
    }
  }, { revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false })
}
