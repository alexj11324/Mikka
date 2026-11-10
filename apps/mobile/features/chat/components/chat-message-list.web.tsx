import { forwardRef, useImperativeHandle, useRef, useState, type ReactElement } from 'react'
import { StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { LegendList, type LegendListRef } from '@legendapp/list/react-native'
import { ANCHOR_GAP, CHAT_LIST_ESTIMATED_ROW, CHAT_ROW_GAP, isAtLatest } from '@/features/chat/model/chat-layout'
import { VIRTUALIZED_CHAT_LIST, type ChatListHandle, type ChatListProps } from './chat-message-list.types'

export { VIRTUALIZED_CHAT_LIST, type ChatListHandle, type ChatListProps }

/** Expo Web: the same list without the keyboard controller, which has no browser counterpart. A short chat still sits against the composer. */
function ChatMessageListInner<T>({ data, keyOf, renderItem, header, footer, bottomInset, onStartReached, onAtLatestChange, onScrollUnderBar, anchorIndex, testID }: ChatListProps<T>, ref: React.Ref<ChatListHandle>) {
  const list = useRef<LegendListRef>(null)
  // The anchored space counts the rows after the anchor but not the footer (the waiting line, notices): the anchor
  // sits that much lower so the footer does not push it above the top.
  const [footerHeight, setFooterHeight] = useState(0)
  const atLatest = useRef(true)
  useImperativeHandle(ref, () => ({ toLatest: (animated = false) => { void list.current?.scrollToEnd({ animated }) } }), [])
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    onScrollUnderBar?.(event)
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    const latest = isAtLatest(contentOffset.y, contentSize.height, layoutMeasurement.height)
    if (latest !== atLatest.current) { atLatest.current = latest; onAtLatestChange(latest) }
  }
  // The web build hands unknown props to the DOM, so the test id sits on a wrapper and the list keeps the browser's own scroll.
  return (
    <View testID={testID} style={styles.fill}>
    <LegendList
      ref={list}
      style={styles.fill}
      data={data}
      keyExtractor={keyOf}
      renderItem={({ item, index }) => <View style={styles.row}>{renderItem(item, index)}</View>}
      recycleItems={false}
      estimatedItemSize={CHAT_LIST_ESTIMATED_ROW}
      ItemSeparatorComponent={Separator}
      initialScrollAtEnd
      alignItemsAtEnd
      maintainScrollAtEnd={{ animated: false, on: { dataChange: true, itemLayout: anchorIndex === undefined, footerLayout: true, layout: true } }}
      anchoredEndSpace={anchorIndex === undefined ? undefined : { anchorIndex, anchorOffset: ANCHOR_GAP + footerHeight }}
      maintainVisibleContentPosition={{ data: true }}
      onStartReached={onStartReached ? () => onStartReached() : undefined}
      onStartReachedThreshold={0.5}
      ListHeaderComponent={header ? <View style={styles.row}>{header}</View> : undefined}
      ListFooterComponent={footer ? <View style={styles.footer} onLayout={event => setFooterHeight(event.nativeEvent.layout.height)}>{footer}</View> : undefined}
      contentContainerStyle={{ paddingBottom: bottomInset + 16 }}
      onScroll={onScroll}
      scrollEventThrottle={16}
    />
    </View>
  )
}

const Separator = () => <View style={styles.separator} />

export const ChatMessageList = forwardRef(ChatMessageListInner) as <T>(props: ChatListProps<T> & { ref?: React.Ref<ChatListHandle> }) => ReactElement

const styles = StyleSheet.create({
  separator: { height: CHAT_ROW_GAP },
  // Legend List places each row itself, so the side margins go on the rows, not the content container.
  fill: { flex: 1 },
  row: { paddingHorizontal: 16 },
  footer: { paddingHorizontal: 16, paddingTop: CHAT_ROW_GAP, gap: CHAT_ROW_GAP },
})
