/**
 * The home row's swipe (#1408 Phase 2b; Comma design 03). The row moves left with the finger; two capsules show
 * behind it, 置顶 and 隐藏, fully at 148 pt. A swipe past 230 pt arms the pin, which is made on release; back under
 * 210 pt disarms it.
 */
export const SWIPE_REVEAL = 148
export const PIN_COMMIT = 230
export const PIN_DISARM = 210

/** Where a released swipe goes: the pin when armed, open past halfway (or a quick flick left), else closed. */
export function settleSwipe(offset: number, velocity: number, armed: boolean): 'pin' | 'open' | 'close' {
  'worklet'
  if (armed) return 'pin'
  const projected = offset + velocity * 0.15
  return projected < -SWIPE_REVEAL / 2 ? 'open' : 'close'
}

/** Whether the swipe is armed after a move: it arms past the full mark and stays armed until back under the disarm mark. */
export function armedAt(distance: number, wasArmed: boolean): boolean {
  'worklet'
  return wasArmed ? distance >= PIN_DISARM : distance >= PIN_COMMIT
}
