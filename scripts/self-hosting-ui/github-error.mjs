const RESOURCES = new Set(['Commit', 'Tree', 'Blob', 'Reference'])
const FIELDS = new Set(['tree', 'parents', 'author', 'committer', 'message', 'sha', 'ref', 'email', 'name', 'date', 'signature',
  'author.email', 'author.name', 'author.date', 'committer.email', 'committer.name', 'committer.date'])
const CODES = new Set(['missing', 'missing_field', 'invalid', 'already_exists', 'unprocessable', 'custom'])

/** Preserve GitHub's bounded validation fields, never response text or values. */
export function githubEvidenceFailure(body, headers) {
  const message = typeof body?.message === 'string' ? body.message : ''
  const referenceExists = /^Reference already exists\.?$/i.test(message) || (Array.isArray(body?.errors) && body.errors.some(
    error => error?.resource === 'Reference' && error.field === 'ref' && error.code === 'already_exists'))
  const category = referenceExists ? 'reference_exists'
    : /(?:secondary |API )?rate limit|spammed/i.test(message) ? 'rate_limited'
    : /^Validation Failed\b/i.test(message) ? 'validation_failed'
      : /(?:tree|commit|blob|object).*(?:not found|does not exist)/i.test(message) ? 'object_missing'
        : /(?:author|committer).*(?:invalid|missing)/i.test(message) ? 'identity_invalid' : 'unknown'
  const errors = Array.isArray(body?.errors) ? body.errors.slice(0, 8).map(error => ({
    resource: RESOURCES.has(error?.resource) ? error.resource : 'unknown',
    field: FIELDS.has(error?.field) ? error.field : 'unknown',
    code: CODES.has(error?.code) ? error.code : 'unknown',
  })) : []
  const integer = name => /^\d{1,10}$/.test(headers.get(name) ?? '') ? Number(headers.get(name)) : null
  return { category, errors, errorsTruncated: Array.isArray(body?.errors) && body.errors.length > errors.length,
    retryAfter: integer('retry-after'), rateLimitRemaining: integer('x-ratelimit-remaining'), rateLimitReset: integer('x-ratelimit-reset') }
}
