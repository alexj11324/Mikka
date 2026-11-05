/**
 * Geometry for the chat's pictures (#1408 Phase 3): one picture in a frame, several as a fanned stack of cards, and
 * the full-screen viewer. Pure numbers so they can be tested; the worklets call the same functions.
 */
export type Size = { width: number; height: number }
export type Rect = { x: number; y: number; width: number; height: number }

/** One picture: 240 tall, as wide as its shape allows between 72 and 280, never cropped. */
export const FRAME_HEIGHT = 240
export const FRAME_MIN_WIDTH = 72
export const FRAME_MAX_WIDTH = 280
export const FRAME_RADIUS = 18

export function frameSize(aspect: number | null, column: number): Size {
  const ratio = aspect && aspect > 0 ? aspect : 3 / 4
  const maxWidth = Math.min(FRAME_MAX_WIDTH, column)
  const width = FRAME_HEIGHT * ratio
  if (width > maxWidth) return { width: maxWidth, height: Math.max(1, Math.round(maxWidth / ratio)) }
  return { width: Math.max(FRAME_MIN_WIDTH, Math.round(width)), height: FRAME_HEIGHT }
}

/** Several pictures: a stack of 196×252 cards (narrower on a small screen), the next two fanned out behind. */
export const STACK_CARD: Size = { width: 196, height: 252 }
export const STACK_SPREAD = 20
export const STACK_LIFT = 14

export function stackCard(screenWidth: number): Size {
  const width = Math.min(STACK_CARD.width, Math.min(280, screenWidth - 80) - 40)
  return { width, height: Math.round(width * STACK_CARD.height / STACK_CARD.width) }
}

/** Each layer's pose: offset, rotation in degrees and scale; `mirror` fans the other way for the person's messages. */
export function layerPose(depth: number, mirror: boolean) {
  const poses = [{ x: 0, y: 0, rotate: 0, scale: 1 }, { x: -12, y: 6, rotate: -6, scale: 0.94 }, { x: 12, y: 10, rotate: 5, scale: 0.9 }]
  const pose = poses[Math.min(depth, 2)]!
  return { ...pose, x: mirror ? -pose.x : pose.x, rotate: mirror ? -pose.rotate : pose.rotate, opacity: depth > 2 ? 0 : 1 }
}

/** A sideways drag on the stack throws the front card to the back past 40% of half a card, or on a flick. */
export function throwsCard(translation: number, velocity: number, cardWidth: number) {
  'worklet'
  const half = cardWidth / 2
  return Math.abs(translation) > 0.4 * half || (Math.abs(velocity) > 500 && Math.sign(velocity) === Math.sign(translation || velocity))
}

/** The viewer: where a picture of `aspect` sits on a screen, inside its chrome. */
export const VIEWER_SIDE = 16
export const VIEWER_CHROME = 48

export function fittedRect(aspect: number | null, screen: Size, insets: { top: number; bottom: number }, strip: boolean): Rect {
  const ratio = aspect && aspect > 0 ? aspect : 3 / 4
  const vertical = Math.max(insets.top + 8 + VIEWER_CHROME, insets.bottom + (strip ? VIEWER_CHROME : 0)) + 12
  const boxWidth = screen.width - VIEWER_SIDE * 2
  const boxHeight = Math.max(1, screen.height - vertical * 2)
  const width = Math.min(boxWidth, boxHeight * ratio)
  const height = width / ratio
  return { x: (screen.width - width) / 2, y: (screen.height - height) / 2, width, height }
}

/** Zoom stays between 1 and 4; past either end it gives way like a rubber band. */
export const MIN_ZOOM = 1
export const MAX_ZOOM = 4
export const DOUBLE_TAP_ZOOM = 2.5

export function clampZoom(scale: number) {
  'worklet'
  if (scale < MIN_ZOOM) return MIN_ZOOM - (MIN_ZOOM - scale) * 0.3
  if (scale > MAX_ZOOM) return MAX_ZOOM + (scale - MAX_ZOOM) * 0.3
  return scale
}

/** How far a zoomed picture may move before its edge leaves the screen's edge. */
export function panBounds(rect: Size, scale: number, screen: Size) {
  'worklet'
  return { x: Math.max(0, (rect.width * scale - screen.width) / 2), y: Math.max(0, (rect.height * scale - screen.height) / 2) }
}

/** A drag down (or up) closes the viewer when it would travel past 110 pt, counting a fifth of a second of its speed. */
export function dismisses(translation: number, velocity: number) {
  'worklet'
  const projected = translation + velocity * 0.2
  return Math.abs(projected) > 110 && Math.sign(projected) === Math.sign(translation || projected)
}

/** A sideways drag turns the page past half a step or on a flick; the gap between pages is 24. */
export const PAGE_GAP = 24
export function pageTurn(translation: number, velocity: number, step: number, index: number, count: number) {
  'worklet'
  let next = index
  if (translation < -step / 2 || velocity < -400) next = index + 1
  else if (translation > step / 2 || velocity > 400) next = index - 1
  return Math.max(0, Math.min(count - 1, next))
}

/** The gallery's grid: two square columns; an odd count starts with one picture across the width. */
export function galleryRows(count: number): number[][] {
  const rows: number[][] = []
  let index = 0
  if (count % 2 === 1) rows.push([index++])
  while (index < count) rows.push([index++, index++])
  return rows
}
