/** True when a single-key shortcut would steal a keystroke from what the user is editing. */
function hasClosest(target: unknown): target is Element {
  return !!target && typeof (target as Element).closest === 'function'
}

/** Characters typed before the new-task dialog is in the document. Null means the dialog should receive the key. */
export function bufferTypeAhead(current: string, key: string, dialogReady: boolean, limit = 200) {
  if (dialogReady || key.length !== 1) return null
  return (current + key).slice(0, limit)
}

export function typingOrDialog(target: unknown) {
  if (hasClosest(target) && target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="alertdialog"]')) return true
  const root = globalThis.document
  return !!root && root.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]') !== null
}
