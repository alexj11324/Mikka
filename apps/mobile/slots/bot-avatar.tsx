// The default bot avatar (docs/ui-overlay.md, 「iOS app」). The official build
// draws the hosted layer's mobile/slots/bot-avatar.tsx in its place.
import { useColorScheme, View } from 'react-native'
import Svg, { Circle, Ellipse, Path, Rect } from 'react-native-svg'
import { BOT_SHAPE_DRAWINGS, botFill } from '@/lib/bot-look'
import type { BotAvatarProps } from './bot-avatar-contract'

/** A bot's avatar: its blob in its colour and shape, with one bright eye (a still bloub, R-36). The Coordinator is the ink circle; in dark mode ink is drawn crème, as on the web (bot-avatar.tsx). */
export function BotAvatar({ color = 'encre', shape = 'cercle', size = 24 }: BotAvatarProps) {
  const dark = useColorScheme() === 'dark'
  const c = botFill(color, dark)
  const body = (() => {
    switch (BOT_SHAPE_DRAWINGS[shape] ?? 'circle') {
      case 'circle': return <Circle cx={12} cy={12} r={10} fill={c} />
      case 'squircle': return <Rect x={2.5} y={2.5} width={19} height={19} rx={6.5} fill={c} />
      case 'flower':
        return (
          <>
            {[0, 72, 144, 216, 288].map(a => {
              const r = (a - 90) * Math.PI / 180
              return <Circle key={a} cx={12 + 5.4 * Math.cos(r)} cy={12.4 + 5.4 * Math.sin(r)} r={5} fill={c} />
            })}
            <Circle cx={12} cy={12.4} r={6} fill={c} />
          </>
        )
      case 'cloud':
        return (
          <>
            <Circle cx={8} cy={13} r={6} fill={c} />
            <Circle cx={14} cy={9.5} r={6.5} fill={c} />
            <Circle cx={17} cy={14} r={5.5} fill={c} />
            <Rect x={4} y={13} width={17} height={6.5} rx={3.2} fill={c} />
          </>
        )
      case 'cat':
        return (
          <>
            <Path d="M3.6 10.5 4.6 3l6 4.3M20.4 10.5 19.4 3l-6 4.3" fill={c} stroke={c} strokeWidth={1.6} strokeLinejoin="round" />
            <Ellipse cx={12} cy={13.5} rx={9.4} ry={8} fill={c} />
          </>
        )
      case 'drop': return <Path d="M12 2.2c3.6 4.4 7.8 8.7 7.8 13a7.8 7.8 0 0 1-15.6 0c0-4.3 4.2-8.6 7.8-13z" fill={c} />
    }
  })()
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 24 24">
        {body}
        <Ellipse cx={15.6} cy={8.6} rx={1.5} ry={2.3} fill="#fff" />
      </Svg>
    </View>
  )
}
