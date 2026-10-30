/**
 * Workspace icons are stored inline as a data URL on mikka_workspaces.icon.
 * The repository has no object storage, and account avatars are also a URL
 * string on the user row; a ≤200 KB raster image keeps the row small and needs
 * no extra service. SVG is refused: it can carry script.
 */
export const WORKSPACE_ICON_MAX_BYTES = 200 * 1024

const DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/

const SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  png: bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  gif: bytes => bytes.subarray(0, 4).toString('latin1') === 'GIF8',
  webp: bytes => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP',
}

/** Returns the icon to store, or null to clear; false when it is not an acceptable image. */
export function parseWorkspaceIcon(value: string | null): string | null | false {
  if (value === null || value === '') return null
  // Base64 is 4/3 of the payload; refuse oversized strings before decoding.
  if (value.length > Math.ceil(WORKSPACE_ICON_MAX_BYTES / 3) * 4 + 40) return false
  const match = DATA_URL.exec(value)
  if (!match) return false
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length || bytes.length > WORKSPACE_ICON_MAX_BYTES || !SIGNATURES[match[1]](bytes)) return false
  return value
}
