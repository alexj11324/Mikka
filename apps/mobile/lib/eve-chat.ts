import { useCallback, useEffect } from 'react'
import { useEveAgent } from 'eve/react'
import { idle } from 'eve/events'
import type { MessagePart } from 'eve/client'
import { eveClientOptions } from './eve-client'

/** Native clients consume the same eve protocol as web; auth headers resolve before each request. */
export function useEveChat(botId: string | null, enabled: boolean, revalidate: () => Promise<void>) {
  // The root/account and ChatScreen/workspace boundaries remount this binding on identity changes.
  const agent = useEveAgent({
    ...eveClientOptions(botId),
    optimistic: false,
    followAgents: true,
    followWhile: view => !idle(view),
    onFinish: () => { void revalidate().catch(() => undefined) },
  })
  const { prewarm, resume, send } = agent
  useEffect(() => {
    if (!enabled) return
    let mounted = true
    void prewarm().then(() => mounted ? resume() : undefined).catch(() => undefined)
    return () => { mounted = false }
  }, [enabled, prewarm, resume])
  const sendMessage = useCallback(async (text: string, submissionId: string, images?: readonly { dataUrl: string }[]) => {
    const content: MessagePart[] = [{ type: 'text', text }, ...(images ?? []).map(image => ({ type: 'file' as const, mediaType: /^data:([^;,]+)/.exec(image.dataUrl)?.[1] ?? 'image/jpeg', data: image.dataUrl }))]
    return send(content, { headers: { 'x-mikka-submission-id': submissionId } })
  }, [send])
  return { ...agent, sendMessage }
}

