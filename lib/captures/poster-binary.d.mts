export const POSTER_BINARY_RESOURCE: string
export const POSTER_RUNTIME_DIRECTORY: string
export const POSTER_BINARY_ARCHIVE: string
export const POSTER_BINARY_MANIFEST: string
export const POSTER_LICENSE_FILES: readonly string[]
export const POSTER_BINARY_MAX_BYTES: number
export interface CapturePosterBinaryOptions { root?: string; temporaryRoot?: string }
export function createCapturePosterBinary(options?: CapturePosterBinaryOptions): () => Promise<string>
export const capturePosterBinary: () => Promise<string>
