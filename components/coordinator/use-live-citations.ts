'use client'

import { useMemo } from 'react'
import useSWR from 'swr'
import { coordinatorCitationSources } from '@/app/actions/coordinator'
import type { AgentCitations } from '@/components/workspace/agent-citations'
import { citedIds, type CitationSource } from '@/lib/coordinator/citations'

type Lookup = { ids: string[]; sources: Record<string, CitationSource> }

/**
 * The chat's citations for replies still streaming. The chat's own sources cover stored replies only, so the
 * tasks and threads a live reply cites that it does not know yet are looked up here; until they are, a chip
 * holds their place (`pending`). `streaming` is for the reply still arriving, `settled` for one that has ended.
 */
export function useLiveCitations(texts: readonly string[], citations: AgentCitations): { settled: AgentCitations; streaming: AgentCitations } {
  const known = citations.sources
  const joined = texts.join('\n')
  const ids = useMemo(() => {
    const cited = citedIds([joined])
    return [...new Set([...cited.issueIds, ...cited.runIds])].filter(id => !known[id]).sort()
  }, [joined, known])
  const { data } = useSWR<Lookup>(ids.length ? ['live-citations', ...ids] : null, async ([, ...asked]: string[]) => ({ ids: asked, sources: await coordinatorCitationSources(asked) }), {
    keepPreviousData: true, revalidateOnFocus: false, revalidateIfStale: false, shouldRetryOnError: false,
  })
  const lookedUp = data?.sources
  const answered = data?.ids
  const waiting = ids.some(id => !answered?.includes(id))
  return useMemo(() => {
    const sources = lookedUp ? { ...lookedUp, ...known } : known
    return { settled: { ...citations, sources, pending: waiting }, streaming: { ...citations, sources, pending: true } }
  }, [citations, known, lookedUp, waiting])
}
