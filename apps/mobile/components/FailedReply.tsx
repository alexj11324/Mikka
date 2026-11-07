import { type ReactNode, useRef, useState } from 'react'
import { Platform, StyleSheet, View } from 'react-native'
import { Text } from '@/components/Text'
import { GlassButton } from '@/components/GlassButton'
import { api, ApiError } from '@/lib/api'
import { failureLine, failureSettingsPath } from '@/lib/chat-failure'
import { replyRetryLine, retryReply, type ReplyRetryOutcome } from '@/lib/reply-retry'
import { useHome } from '@/lib/home'
import type { ChatFailure } from '@/lib/types'
import { openCloudBilling, openOnWeb, webChatPath } from '@/lib/web'
import { colors } from '@/lib/theme'
import messages from '../../../messages/zh-CN.json'

/**
 * A reply that did not come: why, in the web's words, with 重试 (the same turn
 * again, POST /api/mobile/chat/retry) and, when the subscription or the
 * hosted model needs something, its settings or the native model menu.
 */
export function FailedReply({ failure, botId, onQueued, modelChoice }: { failure: ChatFailure; botId: string | null; onQueued: () => unknown; modelChoice?: ReactNode }) {
  const line = failureLine(failure)
  const workspaceId = useHome().data?.workspace.id
  const settingsPath = line.recovery === 'models' || line.recovery === 'billing' ? failureSettingsPath(line.recovery, workspaceId) : null
  const modelPath = webChatPath(botId, workspaceId)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [outcome, setOutcome] = useState<ReplyRetryOutcome | null>(null)
  const retry = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setOutcome(null)
    try {
      setOutcome(await retryReply(async () => {
        try { return await api('/api/mobile/chat/retry', { method: 'POST', body: { botId } }) }
        catch (error) {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return { error: error.code }
          throw error
        }
      }, onQueued))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  const cloudBilling = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try { await openCloudBilling() }
    finally { inFlight.current = false; setBusy(false) }
  }
  return (
    <View style={styles.failed}>
      <Text style={styles.error}>{line.text}</Text>
      {outcome ? <Text accessibilityLiveRegion="polite" style={styles.retryResult}>{replyRetryLine(outcome)}</Text> : null}
      <View style={styles.failedActions}>
        {line.retry ? <GlassButton label="重试" busy={busy} onPress={() => void retry()} /> : null}
        {line.recovery === 'cloudBilling' ? <GlassButton label={messages.Settings.cloud.topUp} busy={busy} onPress={() => void cloudBilling()} /> : null}
        {line.recovery === 'model' ? Platform.OS === 'ios' && modelChoice ? modelChoice : <GlassButton label="聊天模型" disabled={!modelPath} onPress={() => { if (modelPath) void openOnWeb(modelPath) }} /> : null}
        {line.recovery === 'models' || line.recovery === 'billing' ? <GlassButton label={line.recovery === 'models' ? '模型与订阅' : '账单'} disabled={!settingsPath} onPress={() => { if (settingsPath) void openOnWeb(settingsPath) }} /> : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  failed: { alignItems: 'center', gap: 10, marginTop: 24 },
  failedActions: { flexDirection: 'row', gap: 8 },
  retryResult: { color: colors.secondary, fontSize: 13, textAlign: 'center' },
  error: { alignSelf: 'center', color: colors.danger, fontSize: 13, textAlign: 'center', marginHorizontal: 24 },
})
