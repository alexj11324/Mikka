/** The native shortcut/action used to open another authenticated Mikka window. */
export interface NewWindowMenuItem {
  label: string
  accelerator: string
  click(): void
}

export function newWindowMenuItem(openWindow: () => void): NewWindowMenuItem {
  return {
    label: 'New Window',
    accelerator: 'CommandOrControl+Shift+N',
    click: openWindow,
  }
}
