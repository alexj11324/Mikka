import { readBoundedBody } from '../test-accounts/http-body.mjs'

export class EvidenceError extends Error {
  constructor(code, { phase = 'input', httpStatus, cause } = {}) {
    super(code, { cause })
    this.code = code
    this.phase = phase
    this.httpStatus = httpStatus
  }
}

/** Only these fields can enter a receipt or CLI output. */
export function publicEvidenceError(error) {
  if (!(error instanceof EvidenceError)) return { code: 'unexpected_error', phase: 'write' }
  return { code: error.code, phase: error.phase, ...(error.httpStatus ? { http_status: error.httpStatus } : {}) }
}

/** Read decoded bytes once without allowing stream cleanup to mask the receipt reason. */
export async function readEvidenceBody(response, limit, phase) {
  try {
    const bytes = await readBoundedBody(response, limit)
    if (!response.body) throw new EvidenceError('empty_response', { phase })
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  } catch (cause) {
    if (cause instanceof Error && cause.message === 'RESPONSE_BODY_TOO_LARGE')
      throw new EvidenceError('response_too_large', { phase, cause })
    throw cause
  }
}
