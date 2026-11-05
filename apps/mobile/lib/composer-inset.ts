import { useState } from 'react'
import { Platform } from 'react-native'
import { useSharedValue } from 'react-native-reanimated'

/** The space a chat keeps between its last message and the composer floating over it. */
const GAP = 16

/**
 * The composer floats over the end of a chat list and grows (a quote, a notice, more lines). On iOS and Android the
 * list keeps clear of it through `KeyboardChatScrollView`'s `extraContentPadding`, the scroll view's own content
 * inset (react-native-skills: contentInset for dynamic spacing), which also keeps the end in view as the composer
 * grows; a padding change moved the content without following it, leaving the last message under the composer.
 * The web build, whose scroll view has no content inset, keeps the padding.
 */
export function useComposerInset(initial = 90) {
  const [height, setHeight] = useState(initial)
  const inset = useSharedValue(initial + GAP)
  const onHeight = (next: number) => { setHeight(next); inset.set(next + GAP) }
  return { height, inset, onHeight, paddingBottom: Platform.OS === 'web' ? height + GAP : GAP }
}
