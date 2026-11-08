// The app's browser column (the window bar's globe) opened or closed from outside the shell: the review page's
// ⋯ 预览 opens it beside the page, on the task's dev server when it has one (decision 2026-11-08, R10b). The shell
// holds the column's state and listens.
export const BROWSER_COLUMN_EVENT = 'mikka:browser-column'

/** `url`: the page to show; without it the column comes back to its last page. */
export type BrowserColumnRequest = { open: boolean; url?: string }

export function setBrowserColumn(open: boolean, url?: string) {
  window.dispatchEvent(new CustomEvent<BrowserColumnRequest>(BROWSER_COLUMN_EVENT, { detail: url ? { open, url } : { open } }))
}
