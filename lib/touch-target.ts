/**
 * A finger needs 44×44px (WCAG 2.5.5). On a coarse pointer an invisible ::after,
 * centred on the control and never smaller than it, grows the hit area to at least
 * that, so nothing moves and the desktop look stays as it is.
 */
const TOUCH_TARGET = 'pointer-coarse:relative pointer-coarse:after:absolute pointer-coarse:after:top-1/2 pointer-coarse:after:left-1/2 pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 pointer-coarse:after:-translate-x-1/2 pointer-coarse:after:-translate-y-1/2'

const PLACED = /(^|\s)([\w-]+:)*(absolute|fixed|sticky)(\s|$)/

/** Leaves out a control that places itself or draws its own ::after (a stretched link). */
export function touchTarget(className: unknown) {
  if (typeof className === 'string' && (className.includes('after:') || PLACED.test(className))) return undefined
  return TOUCH_TARGET
}
