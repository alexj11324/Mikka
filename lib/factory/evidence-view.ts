// What the acceptance window needs to show one entry of the evidence manifest.
// Screenshots and recordings are run captures (`captureId`); everything else
// is text read back through the approval route.

export type EvidenceStage = 'execute' | 'review' | 'verify'
export type EvidenceKind = 'log' | 'report' | 'screenshot' | 'video' | 'request'
export interface EvidenceEntry {
  artifact: string
  kind: EvidenceKind
  stage: EvidenceStage
  runId?: string
  recordedAt?: string
  captureId?: string
  title?: string
  contentType?: string
  durationMs?: number | null
}

const STAGES: readonly EvidenceStage[] = ['execute', 'review', 'verify']

/** A screenshot or recording backed by a run capture; anything else opens as text. */
export const mediaKind = (entry: EvidenceEntry): 'image' | 'video' | null =>
  !entry.captureId ? null : entry.kind === 'screenshot' ? 'image' : entry.kind === 'video' ? 'video' : null

/** The captures serve path, behind the task's acceptance authorization. */
export const evidenceMediaPath = (taskId: string, captureId: string) =>
  `/api/factory/tasks/${encodeURIComponent(taskId)}/evidence/${encodeURIComponent(captureId)}`

/** Prev/next stop at the ends, as a filmstrip does. */
export const stepIndex = (index: number, delta: number, total: number) =>
  total <= 0 ? 0 : Math.min(total - 1, Math.max(0, index + delta))

/** 0:09, 1:05, 12:30. */
export function formatDuration(ms: number | null | undefined) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** Entries by the stage that produced them, in stage order; each keeps its manifest index. */
export function groupByStage(entries: readonly EvidenceEntry[]) {
  return STAGES
    .map(stage => ({ stage, items: entries.map((entry, index) => ({ entry, index })).filter(item => item.entry.stage === stage) }))
    .filter(group => group.items.length > 0)
}

/** The manifest's entries, or none when the body is not the expected shape. */
export const evidenceEntries = (manifest: unknown): EvidenceEntry[] => {
  const artifacts = (manifest as { artifacts?: unknown } | null | undefined)?.artifacts
  return Array.isArray(artifacts) ? artifacts.filter((a): a is EvidenceEntry => Boolean(a) && typeof a.artifact === 'string') : []
}

/** Stage order (execute, review, verify), stable within a stage: the list and the viewer walk the same order. */
export const orderEvidence = (entries: readonly EvidenceEntry[]) =>
  STAGES.flatMap(stage => entries.filter(entry => entry.stage === stage))
