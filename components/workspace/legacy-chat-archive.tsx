'use client'

import { useEffect } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { fetchAgentHistory, useAgentHistory } from '@/hooks/use-agent-history'
import type { AgentHistory, SavedAgentSession } from '@/lib/agent-history'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ConversationPill } from '@/components/nav/conversation-pill'
import { AgentThemeProvider } from './agent-theme'
import { AgentConversation } from './agent-conversation'
import { AgentGenerativeUI } from './agent-generative-ui'
import { AgentInteractionContext } from './agent-interaction'

/** Legacy URLs can select existing history; they can never start another generation. */
export type LegacyChatRequest = { sessionId: string | null; nonce: number }

export function LegacyChatArchive({ userId, initialHistory, request, onActive, onSessions }: {
  userId: string; initialHistory?: AgentHistory; request?: LegacyChatRequest
  onActive?: (sessionId: string | null) => void; onSessions?: (sessions: SavedAgentSession[]) => void
}) {
  const t = useTranslations('LegacyChat')
  const latest = useAgentHistory(userId, initialHistory)
  const selectedId = request?.sessionId ?? latest.data?.sessionId
  const selected = useSWR<AgentHistory>(selectedId && selectedId !== latest.data?.sessionId
    ? [`/api/agent/sessions?sessionId=${encodeURIComponent(selectedId)}`, userId] : null,
  ([url]: [string, string]) => fetchAgentHistory(url), { revalidateOnFocus: false })
  const history = selectedId && selectedId !== latest.data?.sessionId ? selected.data : latest.data
  const error = latest.error ?? selected.error
  useEffect(() => { onActive?.(selectedId ?? null) }, [selectedId, onActive])
  useEffect(() => { onSessions?.(latest.data?.sessions ?? []) }, [latest.data?.sessions, onSessions])

  return <AgentThemeProvider><AgentInteractionContext value={{ busy: true, continueFromAnswer: async () => false }}>
    <section aria-label={t('title')} data-testid="legacy-chat-archive" className="mikka-agent relative flex size-full min-h-0 flex-col">
      <ConversationPill name={history?.sessions.find(session => session.id === selectedId)?.title ?? t('title')} />
      <div aria-hidden="true" className="hidden h-14 shrink-0 md:block" />
      <p role="status" className="px-4 py-2 text-sm text-muted-foreground">{t('readOnly')}</p>
      {error ? <><p role="alert">{t('loadError')}</p><Button variant="outline" onClick={() => { void latest.mutate(); void selected.mutate() }}>{t('retry')}</Button></>
        : !history ? <Skeleton className="h-20 w-2/3" />
          : history.turns.length === 0 ? <p className="px-4 py-2 text-sm text-muted-foreground">{t('empty')}</p>
            : <AgentConversation streaming={false} turns={history.turns.map(turn => ({
              id: turn.id, question: turn.prompt,
              response: <div inert>
                <AgentGenerativeUI response={turn.completion} isStreaming={false} onAction={() => {}} showErrors={false} />
                {turn.error && <p className="text-sm text-muted-foreground">{turn.error}</p>}
                {turn.status !== 'complete' && <p className="text-sm text-muted-foreground">{t('incomplete')}</p>}
              </div>,
            }))} />}
    </section>
  </AgentInteractionContext></AgentThemeProvider>
}
