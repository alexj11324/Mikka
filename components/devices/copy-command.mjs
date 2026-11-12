/**
 * A device install/fix command is copied only after the browser confirms it.
 * Keep a distinct unavailable/denied outcome so callers never claim a write
 * completed just because the button was pressed.
 * @param {string} command
 * @param {{ writeText: (text: string) => Promise<void> } | undefined} clipboard
 * @returns {Promise<'copied' | 'unavailable' | 'denied'>}
 */
export async function writeDeviceCommand(command, clipboard) {
  if (typeof clipboard?.writeText !== 'function') return 'unavailable'
  try {
    await clipboard.writeText(command)
    return 'copied'
  } catch {
    return 'denied'
  }
}
