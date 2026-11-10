import { createHash } from 'node:crypto'
import { z } from 'zod'
import { CAPTURE_CONTENT_TYPES, CAPTURE_MAX_BYTES } from '@mikka/protocol/capture'

const uuid = z.uuid()
const sha = z.string().regex(/^[a-f0-9]{40}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const publicCaptureSchema = z.object({
  captureId: uuid, kind: z.enum(['image', 'video']), contentType: z.enum(CAPTURE_CONTENT_TYPES),
  size: z.number().int().positive(), durationMs: z.number().int().nonnegative().nullable(),
  url: z.string().url(), sha256: digest,
}).strict()
export const publicationEvidenceSchema = z.object({
  version: z.literal(1), taskId: uuid, candidateId: uuid, runId: uuid, sha,
  userId: z.string().min(1), issueId: uuid, digest,
  captures: z.array(publicCaptureSchema).min(1).max(40),
}).strict()
export type PublicCapture = z.infer<typeof publicCaptureSchema>
export type PublicationEvidence = z.infer<typeof publicationEvidenceSchema>

/** Public capture links use only the existing revocable share route. */
export function publicCaptureToken(value: string) {
  let url: URL
  try { url = new URL(value) } catch { return null }
  if (url.href !== value || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) return null
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.startsWith('[')
    || /^\d+(?:\.\d+){3}$/.test(url.hostname)) return null
  return url.pathname.match(/^(?:\/[\w-]+)*\/api\/captures\/shared\/(mkc_[A-Za-z0-9_-]{32})$/)?.[1] ?? null
}

export function publicationEvidenceDigest(evidence: Omit<PublicationEvidence, 'digest'>) {
  return createHash('sha256').update(JSON.stringify({
    version: evidence.version, taskId: evidence.taskId, candidateId: evidence.candidateId,
    runId: evidence.runId, sha: evidence.sha, userId: evidence.userId, issueId: evidence.issueId,
    captures: evidence.captures.map(capture => ({
      captureId: capture.captureId, kind: capture.kind, contentType: capture.contentType,
      size: capture.size, durationMs: capture.durationMs, url: capture.url, sha256: capture.sha256,
    })),
  })).digest('hex')
}

export function validPublicationEvidence(value: unknown): PublicationEvidence | null {
  const parsed = publicationEvidenceSchema.safeParse(value)
  if (!parsed.success) return null
  const result = parsed.data
  if (result.digest !== publicationEvidenceDigest(result)
    || new Set(result.captures.map(capture => capture.captureId)).size !== result.captures.length
    || result.captures.some(capture => !publicCaptureToken(capture.url)
      || capture.size > CAPTURE_MAX_BYTES[capture.kind]
      || (capture.kind === 'video') !== capture.contentType.startsWith('video/'))) return null
  return result
}

export const PR_EVIDENCE_START = '<!-- mikka-visual-evidence:start -->'
export const PR_EVIDENCE_END = '<!-- mikka-visual-evidence:end -->'

/** Task titles and implementation prose are private unless separately shared.
 * The full summary remains in the authenticated acceptance Artifact. */
export function factoryPullRequestText(issueId: string) {
  return { key: issueId, title: `Factory implementation (${issueId})`,
    summary: 'Implementation prepared for human review. Visual verification of this candidate appears below. A person reviews and merges the pull request.' }
}

/** Titles are generated, so captured personal data never becomes public PR prose. */
export function publicationEvidenceMarkdown(evidence: PublicationEvidence) {
  return [PR_EVIDENCE_START, '## Visual verification', `Commit: \`${evidence.sha}\``,
    ...evidence.captures.map((capture, index) => capture.kind === 'image'
      ? `![Screenshot ${index + 1}](${capture.url})`
      : `[Recording ${index + 1}](${capture.url})`),
    `<!-- mikka-visual-evidence-digest:${evidence.digest} -->`, PR_EVIDENCE_END].join('\n\n')
}

/** Replace only the managed block; retain human text and the final task marker. */
export function bodyWithPublicationEvidence(body: string, issueId: string, evidence: PublicationEvidence) {
  const marker = `<!-- mikka-issue:${issueId} -->`
  const trimmed = body.trimEnd()
  if (!trimmed.endsWith(marker)) return null
  let prefix = trimmed.slice(0, -marker.length).trimEnd()
  const start = prefix.indexOf(PR_EVIDENCE_START), end = prefix.indexOf(PR_EVIDENCE_END)
  if ((start < 0) !== (end < 0) || (start >= 0 && (end < start
    || prefix.indexOf(PR_EVIDENCE_START, start + PR_EVIDENCE_START.length) >= 0
    || prefix.indexOf(PR_EVIDENCE_END, end + PR_EVIDENCE_END.length) >= 0))) return null
  const section = publicationEvidenceMarkdown(evidence)
  if (start >= 0) prefix = prefix.slice(0, start) + section + prefix.slice(end + PR_EVIDENCE_END.length)
  else prefix = `${prefix}${prefix ? '\n\n' : ''}${section}`
  const result = `${prefix.trimEnd()}\n\n${marker}`
  return Buffer.byteLength(result) <= 65_000 ? result : null
}
