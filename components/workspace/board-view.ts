/** Where the board keeps the person's view and 显示 options in this browser. */
export const BOARD_SETTINGS_KEY = 'mikka:board-v2'
export const BOARD_VIEW_EVENT = 'mikka:board-view'

/** Opens the board in a view from outside it (an old 任务 link opens the list): saved as the person's choice, and applied to a board already on screen. */
export function showBoardView(view: 'board' | 'list') {
  try {
    const stored = JSON.parse(window.localStorage.getItem(BOARD_SETTINGS_KEY) ?? 'null')
    window.localStorage.setItem(BOARD_SETTINGS_KEY, JSON.stringify({ ...stored, view }))
  } catch { /* storage unavailable */ }
  window.dispatchEvent(new CustomEvent(BOARD_VIEW_EVENT, { detail: view }))
}
