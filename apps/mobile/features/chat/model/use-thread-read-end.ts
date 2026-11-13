import { useCallback, useEffect, useRef } from 'react'
import { AppState, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { api } from '@/lib/api'
import type { ThreadDetail } from '@/lib/types'

/** Only the focused, foreground transcript acknowledges the replies its
 * scroll view actually displays. Layout events also cover a one-screen chat. */
export function useThreadReadEnd(receipts: ThreadDetail['readReceipts'], onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void) {
  const state = useRef({ focused: false, height: 0, content: 0, offset: 0 })
  const sent = useRef(new Set<string>())
  const current = useRef(receipts)
  current.current = receipts
  const acknowledge = useCallback(() => {
    const { focused, height, content, offset } = state.current
    if (!focused || AppState.currentState !== 'active' || !height || !content || content - offset - height > 2) return
    for (const row of current.current ?? []) {
      const key = JSON.stringify([row.id, row.revision, row.through])
      if (!row.unread || sent.current.has(key)) continue
      sent.current.add(key)
      void api('/api/conversations/read-state', { method: 'POST', body: {
        action: 'read', runId: row.id, through: row.through, revision: row.revision,
      } }).catch(() => sent.current.delete(key))
    }
  }, [])
  useFocusEffect(useCallback(() => {
    state.current.focused = true
    acknowledge()
    const subscription = AppState.addEventListener('change', acknowledge)
    return () => { state.current.focused = false; subscription.remove() }
  }, [acknowledge]))
  useEffect(() => {
    const frame = requestAnimationFrame(acknowledge)
    return () => cancelAnimationFrame(frame)
  }, [receipts, acknowledge])
  return {
    onLayout(event: LayoutChangeEvent) { state.current.height = event.nativeEvent.layout.height; acknowledge() },
    onContentSizeChange(_width: number, height: number) { state.current.content = height; acknowledge() },
    onScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
      Object.assign(state.current, { offset: contentOffset.y, content: contentSize.height, height: layoutMeasurement.height })
      acknowledge()
      onScroll(event)
    },
  }
}
