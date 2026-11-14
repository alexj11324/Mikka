import { useState } from 'react'
import { View } from 'react-native'
import { GlassButton } from '@/components/GlassButton'
import { Segmented } from '@/components/Segmented'
import { Text } from '@/components/Text'
import { api } from '@/lib/api'
import { mobileMessages } from '@/lib/messages'
import { changeMobileQueuedReply } from '@/lib/conversation-submission'
import type { ThreadDeliveryMode, ThreadDeliveryView } from '../../../../../lib/thread-delivery'

export function useThreadDeliveryControls(runId: string | null, issueId: string | null, view: ThreadDeliveryView | undefined, reload: () => Promise<void>) {
  const [preferred, setPreferred] = useState<ThreadDeliveryMode>('queue')
  const [failure, setFailure] = useState('')
  const mode = view?.modes.includes(preferred) ? preferred : view?.modes[0]
  const copy = mobileMessages.IssueThreads
  async function change(messageId: string, action: 'cancel' | 'sendNow') {
    if (!runId) return
    try {
      const outcome = await changeMobileQueuedReply({ kind: 'thread', id: runId, issueId }, messageId, action, (path, init) => api(path, init))
      setFailure(outcome === 'tooLate' ? copy.deliveryTooLate : '')
      await reload()
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      setFailure((mobileMessages.Errors as Record<string,string>)[code] ?? mobileMessages.Coordinator.sendUncertain)
    }
  }
  const controls = view && <View style={{ gap: 4 }}>
    {mode && <Segmented options={view.modes.map(value => ({ value, label: copy.deliveryModes[value] }))} value={mode} onChange={setPreferred} />}
    {view.queued.map(row => <View key={row.id} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
      <Text style={{ flex: 1 }}>{row.text}</Text>
      <Text>{row.status === 'failed' ? (mobileMessages.Errors as Record<string,string>)[row.failureCode ?? ''] ?? copy.deliveryFailed : row.status === 'delivering' ? copy.deliverySending : copy.deliveryQueued}</Text>
      {row.status === 'queued' && <>
        {view.modes.includes('steer') && <GlassButton label={copy.deliverySendNow} onPress={() => void change(row.id, 'sendNow')} />}
        <GlassButton label={copy.deliveryCancel} onPress={() => void change(row.id, 'cancel')} />
      </>}
    </View>)}
    {failure ? <Text accessibilityRole="alert">{failure}</Text> : null}
  </View>
  return { mode, controls }
}
