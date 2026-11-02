import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { ChatCard, CardButton, cardText } from '@/components/cards'
import { Text } from '@/components/Text'
import { api, ApiError } from '@/lib/api'
import { nextWhen } from '@/lib/clock'
import { failureSettingsPath } from '@/lib/chat-failure'
import { useHome } from '@/lib/home'
import type { ThreadPaused } from '@/lib/types'
import { openOnWeb } from '@/lib/web'

/** A quota pause keeps the original credential. Using a paid key requires
 * this explicit action; retrying after reset still uses the subscription. */
export function ThreadQuotaPaused({ paused, onContinued }: { paused: ThreadPaused; onContinued: (runId: string) => unknown }) {
  const workspaceId = useHome().data?.workspace.id
  const [pending, setPending] = useState<'key' | 'retry' | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const inFlight = useRef(false), mounted = useRef(true)
  const [reset, setReset] = useState(() => !paused.resetsAt || Date.parse(paused.resetsAt) <= Date.now())
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!paused.resetsAt) { setReset(true); return }
    const wait = Date.parse(paused.resetsAt) - Date.now()
    setReset(wait <= 0)
    if (wait <= 0 || !Number.isFinite(wait)) return
    const timer = setTimeout(() => setReset(true), Math.min(wait, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [paused.resetsAt])
  const run = async (via: 'key' | 'retry') => {
    if (inFlight.current) return
    inFlight.current = true; setPending(via); setFeedback(null)
    try {
      const result = await api<{ runId: string }>(`/api/mobile/threads/${paused.runId}/continue`, { method: 'POST', body: { via } })
      if (!mounted.current) return
      setFeedback('继续已排队')
      try { await onContinued(result.runId) } catch { /* a refresh cannot undo the confirmed continuation */ }
    } catch (error) {
      if (mounted.current) setFeedback(error instanceof ApiError && error.status >= 400 && error.status < 500 ? '未能继续' : '继续未确认')
    } finally { inFlight.current = false; if (mounted.current) setPending(null) }
  }
  const name = `${paused.subscription === 'claude' ? 'Claude' : 'ChatGPT'}${paused.plan ? ` ${paused.plan}` : ''}`
  const settings = failureSettingsPath('models', workspaceId)!
  return <ChatCard>
    <Text style={cardText.title}>{name} 额度已用完</Text>
    {paused.resetsAt && !reset ? <Text style={cardText.meta}>{nextWhen(paused.resetsAt)} 重置</Text> : null}
    <Text style={cardText.meta}>API Key 按 token 计费</Text>
    <View style={styles.actions}>
      {paused.keyReady
        ? <CardButton label="用 API Key 继续" busy={pending === 'key'} disabled={pending !== null} onPress={() => void run('key')} />
        : <CardButton label="添加 API Key 继续" disabled={pending !== null} onPress={() => void openOnWeb(settings)} />}
      <CardButton label="重置后重试" busy={pending === 'retry'} disabled={!reset || pending !== null} onPress={() => void run('retry')} />
    </View>
    {feedback ? <Text accessibilityLiveRegion="polite" style={cardText.meta}>{feedback}</Text> : null}
  </ChatCard>
}

const styles = StyleSheet.create({ actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 } })
