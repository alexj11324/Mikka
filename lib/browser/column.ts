// The app's browser column (the window bar's globe) opened or closed from outside the shell: the review page's
// ⋯ 预览 opens it beside the page (decision 2026-11-08, R10b). The shell holds the column's state and listens.
export const BROWSER_COLUMN_EVENT = 'mikka:browser-column'

export type BrowserColumnRequest = { open: boolean }

export function setBrowserColumn(open: boolean) {
  window.dispatchEvent(new CustomEvent<BrowserColumnRequest>(BROWSER_COLUMN_EVENT, { detail: { open } }))
}
