// Client-side driver for the secure login card. Secrets are passed straight
// into one request body and never stored, logged or echoed back to the UI.
export type LoginOutcome = 'signed_in' | 'needs_code' | 'rejected' | 'failed'
type Fetch = (input: string, init: RequestInit) => Promise<Response>

const SIGNED_IN = new Set(['submitted', 'session_applied', 'resumed'])

export function loginOutcome(status: number, body: unknown): LoginOutcome {
  if (status < 200 || status >= 300) return 'failed'
  const value = typeof body === 'object' && body !== null ? (body as { status?: unknown }).status : undefined
  if (typeof value === 'string' && SIGNED_IN.has(value)) return 'signed_in'
  if (value === 'guarded') return 'needs_code'
  if (value === 'needs_login') return 'rejected'
  return 'failed'
}

export function createLoginFlow(prefix: string, fetchImpl: Fetch = (input, init) => fetch(input, init)) {
  async function post(path: string, body: object) {
    try {
      const response = await fetchImpl(`${prefix}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-mikka-credential': '1' },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json().catch(() => null) }
    } catch { return { status: 0, body: null } }
  }
  async function nonce(site: string) {
    const challenge = await post('/challenge', { site })
    const value = (challenge.body as { nonce?: unknown } | null)?.nonce
    return challenge.status === 200 && typeof value === 'string' ? value : null
  }
  return {
    async password(site: string, username: string, password: string): Promise<LoginOutcome> {
      const value = await nonce(site)
      if (!value) return 'failed'
      const result = await post('', { nonce: value, origin: site, username, password })
      return loginOutcome(result.status, result.body)
    },
    async code(site: string, code: string): Promise<LoginOutcome> {
      const value = await nonce(site)
      if (!value) return 'failed'
      const result = await post('', { nonce: value, origin: site, code })
      // A code that is accepted but still guarded means the code was wrong.
      const outcome = loginOutcome(result.status, result.body)
      return outcome === 'needs_code' ? 'rejected' : outcome
    },
  }
}
