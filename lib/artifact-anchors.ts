import { z } from 'zod'

/** Offsets are UTF-16 code units in the immutable source, never a rendered DOM. */
export const artifactAnchor = z.object({
  kind: z.enum(['source-range', 'html-element']),
  start: z.number().int().nonnegative(), end: z.number().int().nonnegative(),
  quote: z.string().min(1).max(10000), prefix: z.string().max(256), suffix: z.string().max(256),
  blockId: z.string().max(256).optional(), elementId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/).optional(),
}).strict()
export type ArtifactAnchor = z.infer<typeof artifactAnchor>
export function anchorStatus(anchor: ArtifactAnchor, content: string, mediaType: string, versionId: string, headVersionId: string): 'attached' | 'outdated' | 'orphaned' {
  if (anchor.end <= anchor.start || content.slice(anchor.start, anchor.end) !== anchor.quote ||
    content.slice(Math.max(0, anchor.start - anchor.prefix.length), anchor.start) !== anchor.prefix ||
    content.slice(anchor.end, anchor.end + anchor.suffix.length) !== anchor.suffix) return 'orphaned'
  if (anchor.kind === 'html-element') {
    // Raw HTML selectors cannot safely establish DOM identity without a parser and
    // sandbox renderer. Retain the supplied identity for a future renderer, but
    // fail closed today. HTML source-range anchors are supported separately.
    return 'orphaned'
  }
  if (mediaType === 'text/html' && anchor.elementId) return 'orphaned'
  return versionId === headVersionId ? 'attached' : 'outdated'
}
/** Mandatory contract for the future HTML renderer. No privileged message bridge. */
export const ARTIFACT_HTML_POLICY = Object.freeze({
  sandbox: '',
  csp: "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  allowPrivilegedPostMessage: false,
})
