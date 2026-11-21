export const DEVICE_NAME_MAX = 60
export const DEVICE_DESCRIPTION_MAX = 500

/** A user rename must change the displayed name and fit the server's trimmed-name limit. */
export function canRenameDevice(currentName: string, input: string): boolean {
  const name = input.trim()
  return name.length > 0 && name.length <= DEVICE_NAME_MAX && name !== currentName
}
