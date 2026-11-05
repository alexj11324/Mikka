/**
 * The home row's swipe to pin (#1408 Phase 2b). The row moves left with the finger; 置顶 shows behind it at 88 pt,
 * and a swipe past 144 pt arms the pin, which is made on release. Back under 128 pt disarms it.
 */
export const PIN_REVEAL = 88
export const PIN_COMMIT = 144
export const PIN_DISARM = 128

/** Where a released swipe goes: the pin when armed, open at 88 pt past halfway (or a quick flick left), else closed. */
export function settleSwipe(offset: number, velocity: number, armed: boolean): 'pin' | 'open' | 'close' {
  'worklet'
  if (armed) return 'pin'
  const projected = offset + velocity * 0.15
  return projected < -PIN_REVEAL / 2 ? 'open' : 'close'
}

/** Whether the swipe is armed after a move: it arms past the full mark and stays armed until back under the disarm mark. */
export function armedAt(distance: number, wasArmed: boolean): boolean {
  'worklet'
  return wasArmed ? distance >= PIN_DISARM : distance >= PIN_COMMIT
}
