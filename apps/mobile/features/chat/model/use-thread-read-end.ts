import { useCallback, useEffect, useMemo, useRef } from 'react'
import { AppState, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { api } from '@/lib/api'
import { onAppForeground } from '@/lib/useApi'
import type { ThreadDetail } from '@/lib/types'

/** Only the focused, foreground transcript acknowledges the replies its
 * scroll view actually displays. Layout events also cover a one-screen chat. */
export function useThreadReadEnd(conversationId: string, receipts: ThreadDetail['readReceipts'], onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void) {
  // Expo can reuse a route when only its parameters change. Its new ScrollView
  // must report its own measurements before any reply is acknowledged.
  const viewport = useMemo(() => ({
    focused: false, height: 0, content: 0, offset: 0, sent: new Set<string>(),
  }), [conversationId])
  const current = useRef(receipts)
  current.current = receipts
  const acknowledge = useCallback(() => {
    const { focused, height, content, offset } = viewport
    if (!focused || AppState.currentState !== 'active' || !height || !content || content - offset - height > 2) return
    for (const row of current.current ?? []) {
      const key = JSON.stringify([row.id, row.revision, row.through])
      if (!row.unread || viewport.sent.has(key)) continue
      viewport.sent.add(key)
      void api('/api/conversations/read-state', { method: 'POST', body: {
        action: 'read', runId: row.id, through: row.through, revision: row.revision,
      } }).catch(() => viewport.sent.delete(key))
    }
  }, [viewport])
  useFocusEffect(useCallback(() => {
    viewport.focused = true
    acknowledge()
    const unwatch = onAppForeground(acknowledge)
    return () => { viewport.focused = false; unwatch() }
  }, [acknowledge, viewport]))
  useEffect(() => {
    const frame = requestAnimationFrame(acknowledge)
    return () => cancelAnimationFrame(frame)
  }, [receipts, acknowledge])
  return {
    onLayout(event: LayoutChangeEvent) { viewport.height = event.nativeEvent.layout.height; acknowledge() },
    onContentSizeChange(_width: number, height: number) { viewport.content = height; acknowledge() },
    onScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
      Object.assign(viewport, { offset: contentOffset.y, content: contentSize.height, height: layoutMeasurement.height })
      acknowledge()
      onScroll(event)
    },
  }
}
