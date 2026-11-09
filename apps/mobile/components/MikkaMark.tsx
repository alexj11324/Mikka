import { Circle, G, Svg } from 'react-native-svg'
import { colors } from '@/lib/theme'

// Canonical dot-grid M from components/brand/mikka-mark.tsx and docs/design/brand.md.
const SOLID = [
  [26, 26], [74, 26],
  [26, 38], [38, 38], [62, 38], [74, 38],
  [26, 50], [50, 50], [74, 50],
  [26, 62], [74, 62],
  [26, 74], [74, 74],
]
const GHOST = [
  [38, 26], [50, 26], [62, 26],
  [50, 38],
  [38, 50], [62, 50],
  [38, 62], [50, 62], [62, 62],
  [38, 74], [50, 74], [62, 74],
]

export function MikkaMark() {
  return (
    <Svg width={56} height={56} viewBox="19.2 19.2 61.6 61.6" fill={colors.text} accessible={false}>
      <G opacity={0.1}>
        {GHOST.map(([cx, cy]) => <Circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={4.8} />)}
      </G>
      {SOLID.map(([cx, cy]) => <Circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={4.8} />)}
    </Svg>
  )
}
