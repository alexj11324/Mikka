/**
 * The 8 bot shapes bloub doesn't ship (Figma BotAvatar 196:3571, drawn in the
 * design thread): 爱心, 星星, 花, 猫, 蘑菇, 幽灵, 叶子, 屏幕. bloub draws a
 * shape from 64 polar radii, so each is either an inside(x, y) test (svg
 * coordinates, y down, unit ≈ body radius) marched along each angle, or a
 * polar formula. Registered once into bloub's SHAPE_BY_ID; they morph like the
 * built-in ones.
 */
export const EXTRA_SHAPE_IDS = ['coeur', 'etoile', 'fleur', 'chat', 'champignon', 'fantome', 'feuille', 'ecran'] as const
type ExtraShape = (typeof EXTRA_SHAPE_IDS)[number]
type Point = [number, number]

const inCircle = (x: number, y: number, cx: number, cy: number, r: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r
const superEllipse = (x: number, y: number, a: number, b: number, n: number) => Math.abs(x / a) ** n + Math.abs(y / b) ** n <= 1
function inTriangle(x: number, y: number, a: Point, b: Point, c: Point) {
  const side = (p: Point, q: Point, r: Point) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1])
  const point: Point = [x, y]
  const d1 = side(point, a, b), d2 = side(point, b, c), d3 = side(point, c, a)
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
}
/** A triangle grown by r, for soft ear tips. */
function roundTriangle(x: number, y: number, a: Point, b: Point, c: Point, r: number) {
  if (inTriangle(x, y, a, b, c)) return true
  const segment = (p: Point, q: Point) => {
    const vx = q[0] - p[0], vy = q[1] - p[1]
    const t = Math.max(0, Math.min(1, ((x - p[0]) * vx + (y - p[1]) * vy) / (vx * vx + vy * vy)))
    return Math.hypot(x - p[0] - t * vx, y - p[1] - t * vy)
  }
  return Math.min(segment(a, b), segment(b, c), segment(c, a)) <= r
}

const INSIDE: Partial<Record<ExtraShape, (x: number, y: number) => boolean>> = {
  coeur: (x, y) => { const X = x * 1.08, Y = -(y * 1.08) + 0.12; return (X * X + Y * Y - 1) ** 3 - X * X * Y ** 3 <= 0 },
  chat: (x, y) => superEllipse(x, y - 0.1, 0.98, 0.86, 2.6) || roundTriangle(x, y, [-0.98, -0.1], [-0.78, -1.0], [-0.12, -0.62], 0.14) || roundTriangle(x, y, [0.98, -0.1], [0.78, -1.0], [0.12, -0.62], 0.14),
  champignon: (x, y) => (y <= 0.12 && superEllipse(x, y - 0.12, 1.12, 0.92, 2.2)) || (Math.abs(x) <= 1.12 && y > 0.12 && y <= 0.24 && superEllipse(x, 0, 1.12, 1, 4)) || superEllipse(x, y - 0.5, 0.46, 0.42, 3),
  fantome: (x, y) => inCircle(x, y, 0, -0.12, 0.82) || (Math.abs(x) <= 0.82 && y >= -0.12 && y <= 0.66 + 0.16 * Math.cos((x + 0.82) / 1.64 * 3 * 2 * Math.PI)),
  feuille: (x, y) => { const c = Math.SQRT1_2, u = (x + y) * c, v = (y - x) * c; return inCircle(u, v, 0, 0.62, 1.18) && inCircle(u, v, 0, -0.62, 1.18) },
  ecran: (x, y) => superEllipse(x, y, 1.12, 0.84, 5),
}
const POLAR: Partial<Record<ExtraShape, (t: number) => number>> = {
  etoile: t => 0.8 + 0.3 * ((1 + Math.cos(5 * (t + Math.PI / 2))) / 2) ** 2.2,
  fleur: t => 0.82 + 0.2 * Math.abs(Math.cos(2.5 * (t + Math.PI / 2))) ** 1.5,
}
// The heart's dip and the cat's ears are lost if smoothed.
const SHARP: ExtraShape[] = ['coeur', 'chat']

function radii(id: ExtraShape) {
  const out: number[] = []
  for (let i = 0; i < 64; i++) {
    const t = i / 64 * Math.PI * 2
    const polar = POLAR[id]
    if (polar) { out.push(polar(t)); continue }
    const inside = INSIDE[id]!
    let r = 0
    for (let s = 0.02; s < 1.8; s += 0.004) if (inside(Math.cos(t) * s, Math.sin(t) * s)) r = s
    out.push(r)
  }
  if (!POLAR[id] && !SHARP.includes(id)) {
    const raw = out.slice()
    for (let i = 0; i < 64; i++) out[i] = (raw[(i + 63) % 64] + 2 * raw[i] + raw[(i + 1) % 64]) / 4
  }
  const scale = 1.05 / Math.max(...out)
  return out.map(value => +(value * scale).toFixed(3))
}

let registered = false
/** Adds the extra shapes to bloub's table, once per page. */
export function registerExtraShapes(table: Map<string, { id: string; radii: number[] }>) {
  if (registered) return
  registered = true
  for (const id of EXTRA_SHAPE_IDS) table.set(id, { id, radii: radii(id) })
}

/** bloub's palette, 12 colours (Figma 195:3226). Ink turns cream in the dark theme. */
export const BOT_COLORS = ['encre', 'brun', 'rouge', 'orange', 'ambre', 'vert', 'turquoise', 'bleu', 'violet', 'rose', 'gris', 'creme'] as const
export type BotColor = (typeof BOT_COLORS)[number]
export const DEFAULT_BOT_COLOR: BotColor = 'encre'

/** bloub's 8 base shapes, then the 8 above (Figma BotAvatar 196:3571). */
export const BOT_SHAPES = ['cercle', 'galet', 'squircle', 'capsule', 'triangle', 'hexagone', 'nuage', 'goutte', ...EXTRA_SHAPE_IDS] as const
export type BotShape = (typeof BOT_SHAPES)[number]
export const DEFAULT_BOT_SHAPE: BotShape = 'cercle'

/** The longest bot name, in characters (createBot and updateBot). */
export const BOT_NAME_MAX = 60
