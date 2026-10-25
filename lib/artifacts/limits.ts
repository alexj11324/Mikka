import type { ArtifactKind } from '@/lib/db/schema'

// What submit_artifact accepts. Kept out of server-only code so tests and the
// MCP schema share it.

export const ARTIFACT_TITLE_MAX = 200
/** Largest file per version, in bytes of UTF-8. */
export const ARTIFACT_MAX_BYTES: Record<ArtifactKind, number> = { markdown: 1_000_000, html: 2_000_000 }

export const ARTIFACT_CONTENT_TYPES: Record<ArtifactKind, string> = {
  markdown: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
}

export const ARTIFACT_EXTENSIONS: Record<ArtifactKind, string> = { markdown: 'md', html: 'html' }

/** The byte length of `content` as UTF-8. */
export function utf8Bytes(content: string): number {
  return new TextEncoder().encode(content).length
}

/** A title on one line, trimmed to the column's length. */
export function cleanTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, ARTIFACT_TITLE_MAX)
}

/** A file name for downloads: the title without characters file systems reject. */
export function artifactFileName(title: string, kind: ArtifactKind, version: number): string {
  const base = cleanTitle(title).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'artifact'
  return `${base} v${version}.${ARTIFACT_EXTENSIONS[kind]}`
}
