import { useEffect, useRef, useState, type RefObject } from 'react'
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollViewInstance } from 'react-native'
import { ChatScrollPosition } from './chat-scroll'

/** Follow the end until the person scrolls away; prepend history without moving their visible messages. */
export function useChatScroll(scroll: RefObject<ScrollViewInstance | null>, identity: string, paused = false) {
  const position = useRef(new ChatScrollPosition())
  const [atEnd, setAtEnd] = useState(true)
  useEffect(() => { position.current.reset(); setAtEnd(true) }, [identity])
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    const latest = position.current.onScroll(contentOffset.y, contentSize.height, layoutMeasurement.height)
    setAtEnd(latest)
    return latest
  }
  const onContentSizeChange = (_width: number, height: number) => {
    if (paused) return
    const target = position.current.onResize(height)
    if (target === 'end') scroll.current?.scrollToEnd({ animated: false })
    else if (target !== null) scroll.current?.scrollTo({ y: target, animated: false })
  }
  const toLatest = () => { position.current.latest(); setAtEnd(true); scroll.current?.scrollToEnd({ animated: false }) }
  const pause = () => { position.current.pause(); setAtEnd(false) }
  return { atEnd, onScroll, onContentSizeChange, toLatest, pause, preservePrepend: () => position.current.preservePrepend() }
}
