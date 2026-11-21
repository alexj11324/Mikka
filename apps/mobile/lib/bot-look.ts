// A bot's colour and shape ids, shared by the default bot avatar and the hosted layer's (docs/ui-overlay.md).
import { BOT_BLOB_RADII, BOT_SHAPE_IDS } from '@/lib/bot-blob'

/** The web's twelve bot colours (lib/bot-shapes.ts BOT_COLORS), in its order. */
export const BOT_COLORS: Record<string, string> = {
  encre: '#0a0a0c', brun: '#8b5e3c', rouge: '#e8483f', orange: '#f08a24', ambre: '#f0b429', vert: '#3ecf8e',
  turquoise: '#2fbfa0', bleu: '#3b93f0', violet: '#8b5cf6', rose: '#e152b0', gris: '#a3a3a3', creme: '#d9d5ca',
}

/** The shapes 新建 Bot offers: the web's sixteen, in lib/bot-shapes.ts BOT_SHAPES order. */
export const BOT_PICKER_SHAPES = BOT_SHAPE_IDS

/** The colour a bot is drawn in: unknown ids fall back to ink, and ink is drawn crème in dark mode, as on the web. */
export function botFill(color: string | null | undefined, dark: boolean): string {
  const known = color && BOT_COLORS[color] ? color : 'encre'
  return BOT_COLORS[known === 'encre' && dark ? 'creme' : known]
}

/** The avatar's box in viewBox units; the blob keeps the circle's old radius. */
const BOX = 24
const BALL = 10

/** The profile's radius in a direction, interpolated between its two nearest samples (as bloub's radiusAtAngle). */
function radiusAtAngle(radii: readonly number[], angle: number) {
  const at = (((angle / (Math.PI * 2)) % 1) + 1) % 1 * radii.length
  const low = Math.floor(at)
  const a = radii[low % radii.length] ?? 1
  const b = radii[(low + 1) % radii.length] ?? 1
  return a + (b - a) * (at - low)
}

const paths = new Map<string, string>()

/**
 * The shape's bloub outline as an svg path in the BOX×BOX viewBox: the 64 polar
 * samples joined by Catmull-Rom cubics, as bloub's closedPath draws them.
 */
export function blobPath(shape: string | null | undefined): string {
  const id = shape && BOT_BLOB_RADII[shape] ? shape : 'cercle'
  const cached = paths.get(id)
  if (cached) return cached
  const radii = BOT_BLOB_RADII[id]!
  const n = radii.length
  const points = radii.map((radius, i) => {
    const angle = (i / n) * Math.PI * 2
    return [BOX / 2 + radius * BALL * Math.cos(angle), BOX / 2 + radius * BALL * Math.sin(angle)] as const
  })
  const f = (value: number) => Math.round(value * 100) / 100
  let path = `M${f(points[0]![0])} ${f(points[0]![1])}`
  for (let i = 0; i < n; i++) {
    const a = points[(i - 1 + n) % n]!, o = points[i]!, s = points[(i + 1) % n]!, c = points[(i + 2) % n]!
    const t = 1 / 6
    path += `C${f(o[0] + (s[0] - a[0]) * t)} ${f(o[1] + (s[1] - a[1]) * t)} ${f(s[0] - (c[0] - o[0]) * t)} ${f(s[1] - (c[1] - o[1]) * t)} ${f(s[0])} ${f(s[1])}`
  }
  path += 'Z'
  paths.set(id, path)
  return path
}

/**
 * Where the blob's eye sits, as a centre offset in viewBox units: the circle's
 * historic spot, pulled inward where a shape's edge comes closer (an eye
 * floating off the silhouette reads as a detached dot).
 */
export function blobEye(shape: string | null | undefined): { x: number; y: number } {
  const radii = BOT_BLOB_RADII[shape ?? ''] ?? BOT_BLOB_RADII.cercle!
  const dx = 3.6, dy = -3.4 // the circle's (15.6, 8.6) − centre
  const angle = Math.atan2(dy, dx)
  const reach = Math.min(Math.hypot(dx, dy), radiusAtAngle(radii, angle) * BALL * 0.62)
  const scale = reach / Math.hypot(dx, dy)
  return { x: BOX / 2 + dx * scale, y: BOX / 2 + dy * scale }
}
