export interface RecordingStep { atMs: number; label: string; source: 'action' | 'mark'; durationMs?: number | null }
export interface RecordingWindow { startMs: number; endMs: number }
export interface ProcessedCaptureVideo {
  durationMs: number; size: number; steps: RecordingStep[];
  processing: { version: number; originalDurationMs: number; originalSize: number; originalSha256: string; trimmedMs: number; retainedMs: number;
    windows: RecordingWindow[]; width: number; height: number }
}
export const CAPTURE_RAW_MAX_BYTES: number
export const CAPTURE_VIDEO_MAX_BYTES: number
export const CAPTURE_TOOLS_ROOT: string
export const CAPTURE_TOOLS_DIRECTORY: string
export const CAPTURE_TOOLCHAIN: { id: string; release: string; version: string; assets: Record<string, { assetId: number; gzip: boolean; downloadBytes: number; downloadSha256: string; bytes: number; sha256: string }> }
export class CaptureVideoError extends Error { code: string; constructor(code: string, options?: ErrorOptions) }
export function captureVideoBinaries(options?: { directory?: string; ownerId?: number }): Promise<{ ffmpeg: string; ffprobe: string }>
export function normalizeRecordingSteps(input?: unknown): RecordingStep[]
export function recordingWindows(durationMs: number, steps?: RecordingStep[]): RecordingWindow[]
export function remapRecordingSteps(steps: RecordingStep[], windows: RecordingWindow[], durationMs: number): RecordingStep[]
export function processCaptureVideo(input: string, output: string, options?: { steps?: RecordingStep[]; maxBytes?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<ProcessedCaptureVideo>
