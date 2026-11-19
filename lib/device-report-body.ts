/** Total wire budget of a device report (deviceReportSchema): harnesses,
 * quotas and command receipts, with room to spare. */
export const DEVICE_REPORT_MAX_BODY_BYTES = 1024 * 1024

export type ReportBody = { ok: true; value: unknown } | { ok: false; status: 413 }

/** Must wrap withDeviceRoute: device authentication can update lastUsedAt.
 * Oversized requests must not enter even that database-writing boundary. */
export function withDeviceReportBody<Args extends unknown[]>(handler: (request: Request, value: unknown, ...args: Args) => Promise<Response>) {
  return async (request: Request, ...args: Args): Promise<Response> => {
    const body = await readDeviceReportBody(request)
    if (!body.ok) return Response.json({ error: 'Report too large.' }, { status: body.status, headers: { 'Cache-Control': 'private, no-store' } })
    return handler(request, body.value, ...args)
  }
}

/** Count the actual stream before JSON parsing or any report mutation.
 * Content-Length is only an early rejection hint, never the size authority.
 * Invalid JSON/read failures retain the route's existing invalid-body result. */
export async function readDeviceReportBody(request: Request): Promise<ReportBody> {
  const declared = request.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > DEVICE_REPORT_MAX_BODY_BYTES) {
    void request.body?.cancel().catch(() => undefined)
    return { ok: false, status: 413 }
  }
  if (!request.body) return { ok: true, value: null }

  const reader = request.body.getReader()
  // Grow a bounded byte buffer instead of retaining an object per tiny chunk.
  let bytes = new Uint8Array(4096)
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength > DEVICE_REPORT_MAX_BODY_BYTES - size) {
        // Do not wait for a remote producer's cancellation acknowledgement.
        void reader.cancel().catch(() => undefined)
        return { ok: false, status: 413 }
      }
      const required = size + value.byteLength
      if (required > bytes.length) {
        const grown = new Uint8Array(Math.min(DEVICE_REPORT_MAX_BODY_BYTES, Math.max(required, bytes.length * 2)))
        grown.set(bytes.subarray(0, size))
        bytes = grown
      }
      bytes.set(value, size)
      size = required
    }
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes.subarray(0, size))) as unknown }
  } catch {
    return { ok: true, value: null }
  } finally {
    reader.releaseLock()
  }
}
