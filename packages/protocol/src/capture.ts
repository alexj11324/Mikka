import { z } from "zod"

// Screenshots and screen recordings a thread keeps as evidence of its work.
// Shared by the server (storage, routes), the daemon (upload, cloud computer
// tools) and their tests. A capture belongs to one run and its owner.

export const CAPTURE_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
  "video/webm",
] as const
export type CaptureContentType = (typeof CAPTURE_CONTENT_TYPES)[number]
export const CAPTURE_KINDS = ["image", "video"] as const
export type CaptureKind = (typeof CAPTURE_KINDS)[number]
export const CAPTURE_SOURCES = ["cloud_computer", "local"] as const
export type CaptureSource = (typeof CAPTURE_SOURCES)[number]

/** Largest file per kind, in bytes. */
export const CAPTURE_MAX_BYTES: Record<CaptureKind, number> = {
  image: 10_000_000,
  video: 100_000_000,
}
/** Longest a cloud computer recording runs before it stops by itself. */
export const RECORDING_MAX_SECONDS = 300
export const CAPTURE_TITLE_MAX = 200

export const CAPTURE_EXTENSIONS: Record<CaptureContentType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
}

export function captureKind(contentType: CaptureContentType): CaptureKind {
  return contentType.startsWith("video/") ? "video" : "image"
}

const ascii = (bytes: Uint8Array, start: number, text: string) =>
  [...text].every((char, i) => bytes[start + i] === char.charCodeAt(0))

/**
 * The capture type the file's first bytes show, or null. Never trust a
 * declared type or a file name: an HTML file named shot.png is refused.
 */
export function sniffCaptureType(bytes: Uint8Array): CaptureContentType | null {
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 12 && ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return "image/webp"
  if (bytes.length >= 12 && ascii(bytes, 4, "ftyp")) return "video/mp4"
  // EBML header; Matroska files that are not WebM say "matroska" instead.
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 64)))
    return head.includes("webm") ? "video/webm" : null
  }
  return null
}

/** Why a file cannot be a capture, or null when it can. */
export function captureProblem(bytes: Uint8Array, declared?: string): string | null {
  const sniffed = sniffCaptureType(bytes)
  if (!sniffed) return "Not a PNG, JPEG or WebP image, or an MP4 or WebM video."
  if (declared && declared !== sniffed) return `The file is ${sniffed}, not ${declared}.`
  const max = CAPTURE_MAX_BYTES[captureKind(sniffed)]
  if (bytes.length > max) return `At most ${max} bytes for a ${captureKind(sniffed)}.`
  if (bytes.length === 0) return "The file is empty."
  return null
}

/** A title on one line, trimmed to the column's length. */
export function cleanCaptureTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, CAPTURE_TITLE_MAX)
}

const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const title = z.string().trim().min(1).max(CAPTURE_TITLE_MAX)

// --- Daemon upload: begin, send, complete -----------------------------------

/** `POST /v1/runs/:runId/captures`: announce one file the daemon will send. */
export const captureUploadRequest = z.object({
  /** Stable client id, persisted before the first network attempt. */
  captureId: z.uuid().optional(),
  title,
  contentType: z.enum(CAPTURE_CONTENT_TYPES),
  size: z.number().int().min(1).max(CAPTURE_MAX_BYTES.video),
  sha256,
}).strict()
export type CaptureUploadRequest = z.infer<typeof captureUploadRequest>

/**
 * Where the bytes go: straight to object storage with these exact headers,
 * or to the server's `PUT /v1/runs/:runId/captures/:captureId` where no
 * bucket is configured (previews, tests).
 */
export const captureUploadTarget = z.discriminatedUnion("target", [
  z.object({ target: z.literal("storage"), url: z.url({ protocol: /^https$/ }), headers: z.record(z.string(), z.string()) }),
  z.object({ target: z.literal("server") }),
])
export const captureUploadResponse = z.object({
  captureId: z.uuid(),
  upload: captureUploadTarget,
})
export type CaptureUploadResponse = z.infer<typeof captureUploadResponse>

export const captureView = z.object({
  id: z.uuid(),
  kind: z.enum(CAPTURE_KINDS),
  contentType: z.enum(CAPTURE_CONTENT_TYPES),
  title: z.string(),
  size: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().nullable(),
  source: z.enum(CAPTURE_SOURCES),
  createdAt: z.iso.datetime(),
})
export type CaptureView = z.infer<typeof captureView>

/** `POST /v1/runs/:runId/captures/:captureId/complete` */
export const captureCompleteResponse = z.object({ capture: captureView })

// --- Cloud computer: screenshot and recording -------------------------------

/** `POST /v1/runs/:runId/screen`: the cloud computer tools, relayed by the daemon. */
export const screenCaptureRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("screenshot"), title }).strict(),
  z.object({ action: z.literal("start_recording"), title, maxSeconds: z.number().int().min(5).max(RECORDING_MAX_SECONDS).optional() }).strict(),
  z.object({ action: z.literal("stop_recording") }).strict(),
  // A step on the recording's timeline: an action's own description, or a moment the agent marks.
  z.object({ action: z.literal("step"), label: title, source: z.enum(["action", "mark"]) }).strict(),
])
export type ScreenCaptureRequest = z.infer<typeof screenCaptureRequest>
export const screenCaptureResponse = z.discriminatedUnion("action", [
  z.object({ action: z.literal("screenshot"), capture: captureView }),
  z.object({ action: z.literal("start_recording"), recordingId: z.uuid(), stopsAt: z.iso.datetime() }),
  z.object({ action: z.literal("stop_recording"), capture: captureView }),
  z.object({ action: z.literal("step"), recorded: z.boolean() }),
])
export type ScreenCaptureResponse = z.infer<typeof screenCaptureResponse>

export const capturePaths = {
  begin: (runId: string) => `/v1/runs/${encodeURIComponent(runId)}/captures`,
  upload: (runId: string, captureId: string) => `/v1/runs/${encodeURIComponent(runId)}/captures/${encodeURIComponent(captureId)}`,
  complete: (runId: string, captureId: string) => `/v1/runs/${encodeURIComponent(runId)}/captures/${encodeURIComponent(captureId)}/complete`,
  screen: (runId: string) => `/v1/runs/${encodeURIComponent(runId)}/screen`,
}
