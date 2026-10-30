/** True when a single-key shortcut would steal a keystroke from what the user is editing. */
function hasClosest(target: unknown): target is Element {
  return !!target && typeof (target as Element).closest === 'function'
}

/** Characters typed before the new-task dialog is in the document. Null means the dialog should receive the key. */
export function bufferTypeAhead(current: string, key: string, dialogReady: boolean, limit = 200) {
  if (dialogReady || key.length !== 1) return null
  return (current + key).slice(0, limit)
}

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], [role="combobox"], [role="searchbox"], [role="dialog"], [role="alertdialog"]'

export function typingOrDialog(target: unknown) {
  if (hasClosest(target) && target.closest(EDITABLE)) return true
  const root = globalThis.document
  if (!root) return false
  // A key can arrive on <body> while focus is still in a field (or a field just
  // went read-only); check the focused element as well as the event target.
  const active = root.activeElement
  if (active && active !== root.body && hasClosest(active) && active.closest(EDITABLE)) return true
  return root.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open], [role="menu"][data-open], [role="listbox"][data-open]') !== null
}
