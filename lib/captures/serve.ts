import type { CaptureView } from '@mikka/protocol/capture'

/**
 * A capture's file as a response. Single byte ranges are honoured so a
 * browser can seek in a video. Media only, never rendered as a page here.
 */
export function captureFileResponse(request: Request, file: CaptureView & { bytes: Uint8Array<ArrayBuffer> }, extra: Record<string, string> = {}): Response {
  const total = file.bytes.length
  const headers: Record<string, string> = {
    'content-type': file.contentType,
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'",
    'cross-origin-resource-policy': 'same-origin',
    ...extra,
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '')
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1
    if (start >= total || start > end) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${total}` } })
    return new Response(file.bytes.slice(start, end + 1), { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': String(end - start + 1) } })
  }
  return new Response(file.bytes, { headers: { ...headers, 'content-length': String(total) } })
}
