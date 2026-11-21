// The default bot avatar (docs/ui-overlay.md, 「iOS app」). The official build
// draws the hosted layer's mobile/slots/bot-avatar.tsx in its place.
import { memo } from 'react'
import { useColorScheme, View } from 'react-native'
import Svg, { Ellipse, Path } from 'react-native-svg'
import { blobEye, blobPath, botFill } from '@/lib/bot-look'
import type { BotAvatarProps } from './bot-avatar-contract'

/** A bot's avatar: its blob in its colour and shape, with one bright eye (a still bloub, R-36). The Coordinator is the ink circle; in dark mode ink is drawn crème, as on the web (bot-avatar.tsx). */
export const BotAvatar = memo(function BotAvatar({ color = 'encre', shape = 'cercle', size = 24 }: BotAvatarProps) {
  const dark = useColorScheme() === 'dark'
  const c = botFill(color, dark)
  const eye = blobEye(shape)
  return (
    <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path d={blobPath(shape)} fill={c} />
        <Ellipse cx={eye.x} cy={eye.y} rx={1.5} ry={2.3} fill="#fff" />
      </Svg>
    </View>
  )
})
