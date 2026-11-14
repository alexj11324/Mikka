import { useLayoutEffect, useMemo, useState } from 'react'
import { View } from 'react-native'
import { GlassButton } from '@/components/GlassButton'
import { Segmented } from '@/components/Segmented'
import { Text } from '@/components/Text'
import { api } from '@/lib/api'
import { mobileMessages } from '@/lib/messages'
import { changeMobileQueuedReply } from '@/lib/conversation-submission'
import type { ThreadDeliveryMode, ThreadDeliveryView } from '../../../../../lib/thread-delivery'

export function useThreadDeliveryControls(runId: string | null, issueId: string | null, view: ThreadDeliveryView | undefined, reload: () => Promise<void>) {
  const scope = useMemo(() => ({ active: true, pending: new Set<string>() }), [runId, issueId])
  useLayoutEffect(() => { scope.active = true; return () => { scope.active = false } }, [scope])
  const [choice, setChoice] = useState({ scope, mode: 'queue' as ThreadDeliveryMode })
  const [notice, setNotice] = useState({ scope, text: '' })
  const [, redraw] = useState(0)
  const preferred = choice.scope === scope ? choice.mode : 'queue'
  const mode = view?.modes.includes(preferred) ? preferred : view?.modes[0]
  const failure = notice.scope === scope ? notice.text : ''
  const copy = mobileMessages.IssueThreads
  async function change(messageId: string, action: 'cancel' | 'sendNow') {
    if (!runId || !scope.active || scope.pending.has(messageId)) return
    scope.pending.add(messageId)
    redraw(current => current + 1)
    setNotice({ scope, text: '' })
    try {
      const outcome = await changeMobileQueuedReply({ kind: 'thread', id: runId, issueId }, messageId, action, (path, init) => api(path, init))
      if (!scope.active) return
      setNotice({ scope, text: outcome === 'tooLate' ? copy.deliveryTooLate : '' })
      await reload()
    } catch (error) {
      if (!scope.active) return
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined
      const denied = status === 401 || status === 403 || status === 404
      setNotice({ scope, text: (mobileMessages.Errors as Record<string, string>)[code] ?? (denied ? mobileMessages.Coordinator.sendAccessDenied : mobileMessages.Coordinator.sendUncertain) })
    } finally {
      scope.pending.delete(messageId)
      if (scope.active) redraw(current => current + 1)
    }
  }
  const controls = view && <View style={{ gap: 4 }}>
    {mode && <Segmented options={view.modes.map(value => ({ value, label: copy.deliveryModes[value] }))} value={mode} onChange={value => setChoice({ scope, mode: value })} />}
    {view.queued.map(row => <View key={row.id} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
      <Text style={{ flex: 1 }}>{row.text}</Text>
      <Text>{row.status === 'failed' ? (mobileMessages.Errors as Record<string,string>)[row.failureCode ?? ''] ?? copy.deliveryFailed : row.status === 'delivering' ? copy.deliverySending : copy.deliveryQueued}</Text>
      {row.status === 'queued' && <>
        {view.modes.includes('steer') && <GlassButton label={copy.deliverySendNow} disabled={scope.pending.has(row.id)} onPress={() => void change(row.id, 'sendNow')} />}
        <GlassButton label={copy.deliveryCancel} disabled={scope.pending.has(row.id)} onPress={() => void change(row.id, 'cancel')} />
      </>}
    </View>)}
    {failure ? <Text accessibilityRole="alert">{failure}</Text> : null}
  </View>
  return { mode, controls }
}
