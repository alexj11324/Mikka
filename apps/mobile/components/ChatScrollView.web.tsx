import { forwardRef } from 'react'
import { ScrollView, type ScrollViewInstance } from 'react-native'
import type { KeyboardChatScrollViewProps } from 'react-native-keyboard-controller'

/**
 * Web uses browser scroll events directly. The keyboard controller's native
 * event registration does not deliver our JS onScroll updates in Expo Web.
 * History paging and latest-follow need the browser's actual scroll position.
 * Native retains KeyboardChatScrollView in the platform counterpart.
 */
export const ChatScrollView = forwardRef<ScrollViewInstance, KeyboardChatScrollViewProps>(function ChatScrollView({
  ScrollViewComponent: _ScrollViewComponent, inverted: _inverted, keyboardLiftBehavior: _keyboardLiftBehavior,
  freeze: _freeze, offset: _offset, extraContentPadding: _extraContentPadding, blankSpace: _blankSpace,
  applyWorkaroundForContentInsetHitTestBug: _applyWorkaround, onContentInsetChange: _onContentInsetChange,
  onEndVisible: _onEndVisible, ...props
}, ref) {
  return <ScrollView {...props} ref={ref} />
})
