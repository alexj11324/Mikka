import { Text as RNText, type TextProps } from 'react-native'
import { colors, font } from '@/lib/theme'

/** Text in the app's font and ink; pass styles to size it. */
export function Text({ style, ...props }: TextProps) {
  return <RNText {...props} style={[{ fontFamily: font, color: colors.text, fontSize: 16 }, style]} />
}
