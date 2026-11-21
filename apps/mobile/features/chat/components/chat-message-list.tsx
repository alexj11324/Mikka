import { forwardRef, useImperativeHandle, useRef, useState, type ReactElement } from 'react'
import { StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewInstance } from 'react-native'
import { KeyboardAwareLegendList } from '@legendapp/list/keyboard'
import type { LegendListRef } from '@legendapp/list/react-native'
import { KeyboardChatScrollView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { underBar } from '@/components/NavBar'
import { ANCHOR_GAP, CHAT_LIST_ESTIMATED_ROW, CHAT_ROW_GAP, isAtLatest } from '@/features/chat/model/chat-layout'
import { VIRTUALIZED_CHAT_LIST, type ChatListHandle, type ChatListProps } from './chat-message-list.types'

export { VIRTUALIZED_CHAT_LIST, type ChatListHandle, type ChatListProps }

/**
 * A chat's messages, oldest first, on Legend List (#1408): only the rows near the screen are mounted, the chat opens
 * at its latest message (a short chat sits against the composer), a new message keeps the reader at the end when they
 * are there, and an older page loading in front leaves the message they are reading where it is. The keyboard lifts
 * the list while the reader is at the end.
 */
function ChatMessageListInner<T>({ data, extraData, keyOf, renderItem, header, footer, bottomInset, onStartReached, onAtLatestChange, onScrollUnderBar, anchorIndex, scrollEnabled, testID }: ChatListProps<T>, ref: React.Ref<ChatListHandle>) {
  const insets = useSafeAreaInsets()
  // The bar floats over the list on iOS: the anchored message sits under it, not behind it.
  const topOffset = insets.top + 44
  const list = useRef<LegendListRef>(null)
  // The anchored space counts the rows after the anchor but not the footer (the waiting line, notices): the anchor
  // sits that much lower so the footer does not push it above the top.
  const [footerHeight, setFooterHeight] = useState(0)
  const fallback = useRef<ScrollViewInstance>(null)
  const atLatest = useRef(true)
  const following = useRef(true)
  useImperativeHandle(ref, () => ({
    toLatest: (animated = false) => {
      following.current = true
      if (VIRTUALIZED_CHAT_LIST) void list.current?.scrollToEnd({ animated })
      else fallback.current?.scrollToEnd({ animated })
    },
  }), [])
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    onScrollUnderBar?.(event)
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    const latest = isAtLatest(contentOffset.y, contentSize.height, layoutMeasurement.height)
    following.current = latest
    if (latest !== atLatest.current) { atLatest.current = latest; onAtLatestChange(latest) }
  }
  const content = { paddingBottom: bottomInset + 16 }
  const keyboard = { offset: Math.max(insets.bottom, 12) - 8, keyboardDismissMode: 'interactive' as const, keyboardLiftBehavior: 'whenAtEnd' as const }
  if (!VIRTUALIZED_CHAT_LIST) {
    return (
      <KeyboardChatScrollView ref={fallback} testID={testID} scrollEnabled={scrollEnabled} bounces alwaysBounceVertical {...underBar} {...keyboard}
        contentContainerStyle={[content, { paddingHorizontal: 16, gap: CHAT_ROW_GAP }]} onScroll={onScroll} scrollEventThrottle={16}
        onContentSizeChange={() => { if (following.current) fallback.current?.scrollToEnd({ animated: false }) }}>
        {header}
        {data.map((item, index) => <View key={keyOf(item)}>{renderItem(item, index)}</View>)}
        {footer}
      </KeyboardChatScrollView>
    )
  }
  return (
    <KeyboardAwareLegendList
      ref={list}
      testID={testID}
      data={data}
      extraData={extraData}
      keyExtractor={keyOf}
      renderItem={({ item, index }) => <View style={styles.row}>{renderItem(item, index)}</View>}
      // A row holds its own state (arrival, reveal, photos): one reused for another message would show the wrong one.
      recycleItems={false}
      estimatedItemSize={CHAT_LIST_ESTIMATED_ROW}
      ItemSeparatorComponent={Separator}
      initialScrollAtEnd
      alignItemsAtEnd
      // Following the end: a new message, the footer or the screen changing keep the latest in view. A reply growing
      // under the anchored message fills its blank space instead, without scrolling (v0).
      maintainScrollAtEnd={{ animated: false, on: { dataChange: true, itemLayout: anchorIndex === undefined, footerLayout: true, layout: true } }}
      anchoredEndSpace={anchorIndex === undefined ? undefined : { anchorIndex, anchorOffset: topOffset + ANCHOR_GAP + footerHeight }}
      // An older page in front of the chat leaves the message being read where it is.
      maintainVisibleContentPosition={{ data: true }}
      onStartReached={onStartReached ? () => onStartReached() : undefined}
      onStartReachedThreshold={0.5}
      ListHeaderComponent={header ? <View style={styles.row}>{header}</View> : undefined}
      ListFooterComponent={footer ? <View style={styles.footer} onLayout={event => setFooterHeight(event.nativeEvent.layout.height)}>{footer}</View> : undefined}
      contentContainerStyle={content}
      onScroll={onScroll}
      scrollEventThrottle={16}
      scrollEnabled={scrollEnabled}
      bounces
      alwaysBounceVertical
      showsVerticalScrollIndicator
      {...underBar}
      {...keyboard}
    />
  )
}

const Separator = () => <View style={styles.separator} />

export const ChatMessageList = forwardRef(ChatMessageListInner) as <T>(props: ChatListProps<T> & { ref?: React.Ref<ChatListHandle> }) => ReactElement

const styles = StyleSheet.create({
  separator: { height: CHAT_ROW_GAP },
  // Legend List places each row itself, so the side margins go on the rows, not the content container.
  row: { paddingHorizontal: 16 },
  footer: { paddingHorizontal: 16, paddingTop: CHAT_ROW_GAP, gap: CHAT_ROW_GAP },
})
