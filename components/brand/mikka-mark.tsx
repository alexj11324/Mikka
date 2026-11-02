// The dot-matrix M from public/brand, inlined so it takes the text color and
// follows the theme. Sizes per placement: docs/design/brand.md.
const SOLID = [[26, 26], [74, 26], [26, 38], [38, 38], [62, 38], [74, 38], [26, 50], [50, 50], [74, 50], [26, 62], [74, 62], [26, 74], [74, 74]]
const GHOST = [[38, 26], [50, 26], [62, 26], [50, 38], [38, 50], [62, 50], [38, 62], [50, 62], [62, 62], [38, 74], [50, 74], [62, 74]]

export function MikkaMark() {
  return <svg viewBox="19.2 19.2 61.6 61.6" aria-hidden="true" focusable="false" className="size-7 shrink-0" fill="currentColor">
    <g opacity="0.1">{GHOST.map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="4.8" />)}</g>
    {SOLID.map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="4.8" />)}
  </svg>
}

/**
 * Under 16px (docs/design/brand.md): no ghost dots, which blur into a grey square, and dots that touch (r 6 on the
 * 12 pitch), so the solid dots join into one M. Separate dots that small break into a stray glyph (⁞⋈⁞).
 */
export function MikkaMarkSmall() {
  return <svg viewBox="19.2 19.2 61.6 61.6" aria-hidden="true" focusable="false" className="size-3 shrink-0" fill="currentColor" data-mikka-mark="small">
    {SOLID.map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="6" />)}
  </svg>
}
