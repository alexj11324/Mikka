// The app's browser column (the window bar's globe) opened or closed from outside the shell: the review page's
// ⋯ 预览 opens it beside the page, on the task's dev server when it has one (decision 2026-11-08, R10b). The shell
// holds the column's state and listens.
export const BROWSER_COLUMN_EVENT = 'mikka:browser-column'

/**
 * `url`: the page to show; without it the column comes back to its last page. `width`: the column's width for that
 * page, in px, unless the person has chosen one (dragged or remembered); without it the column's own default.
 */
export type BrowserColumnRequest = { open: boolean; url?: string; width?: number }

export function setBrowserColumn(open: boolean, at?: { url: string; width?: number }) {
  window.dispatchEvent(new CustomEvent<BrowserColumnRequest>(BROWSER_COLUMN_EVENT, { detail: { open, ...at } }))
}
