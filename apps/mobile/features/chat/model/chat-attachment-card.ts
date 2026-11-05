/** The attachment card's geometry (#1408 Phase 3): it grows out of the composer's 40 pt 「+」 into a list of rows. */
export const PLUS_SIZE = 40
export const CARD_ROW = 48
export const CARD_PADDING = 8
export const CARD_WIDTH = 236
export const CARD_RADIUS = 28

/** The card's height for `rows` options. */
export const cardHeight = (rows: number) => rows * CARD_ROW + CARD_PADDING * 2

/** A row's fade-in window on the card's 0→1 progress: each row starts a little after the one below it. */
export function rowWindow(index: number): [number, number] {
  const start = 0.15 + index * 0.1
  return [start, start + 0.5]
}

/** The 「+」 glyph fades over the first fifth of the card's progress, so the card replaces it. */
export const PLUS_FADE_END = 0.2

/** Where the card sits inside the composer: its bottom-left corner on the 「+」's, from the two window rects. */
export function cardAnchor(plus: { x: number; y: number; height: number }, composer: { x: number; y: number; height: number }) {
  return { left: plus.x - composer.x, bottom: composer.y + composer.height - (plus.y + plus.height) }
}
