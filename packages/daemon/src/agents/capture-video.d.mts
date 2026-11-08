export interface RecordingStep { atMs: number; label: string; source: 'action' | 'mark'; durationMs?: number | null }
export interface RecordingWindow { startMs: number; endMs: number }
export interface ProcessedCaptureVideo {
  durationMs: number; size: number; steps: RecordingStep[];
  processing: { version: number; originalDurationMs: number; originalSize: number; originalSha256: string; trimmedMs: number; retainedMs: number;
    windows: RecordingWindow[]; width: number; height: number }
}
export const CAPTURE_RAW_MAX_BYTES: number
export const CAPTURE_VIDEO_MAX_BYTES: number
export class CaptureVideoError extends Error { code: string; constructor(code: string, options?: ErrorOptions) }
export function normalizeRecordingSteps(input?: unknown): RecordingStep[]
export function recordingWindows(durationMs: number, steps?: RecordingStep[]): RecordingWindow[]
export function remapRecordingSteps(steps: RecordingStep[], windows: RecordingWindow[], durationMs: number): RecordingStep[]
export function processCaptureVideo(input: string, output: string, options?: { steps?: RecordingStep[]; maxBytes?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<ProcessedCaptureVideo>
