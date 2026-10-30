// Client-side driver for the secure login card. Secrets are passed straight
// into one request body and never stored, logged or echoed back to the UI.
import { loginView, type LoginView } from './login-outcome'

export type { LoginView } from './login-outcome'
type Fetch = (input: string, init: RequestInit) => Promise<Response>
const FAILED: LoginView = { kind: 'error', message: { key: 'failed' }, attemptId: null }

export function createLoginFlow(prefix: string, fetchImpl: Fetch = (input, init) => fetch(input, init)) {
  async function send(path: string, init: RequestInit) {
    try {
      const response = await fetchImpl(`${prefix}${path}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...init,
        headers: { 'content-type': 'application/json', 'x-mikka-credential': '1' },
      })
      return { status: response.status, body: await response.json().catch(() => null) }
    } catch { return { status: 0, body: null } }
  }
  const post = (path: string, body: object) => send(path, { method: 'POST', body: JSON.stringify(body) })
  async function nonce(site: string) {
    const challenge = await post('/challenge', { site })
    const value = (challenge.body as { nonce?: unknown } | null)?.nonce
    return challenge.status === 200 && typeof value === 'string' ? value : null
  }
  async function submit(site: string, fields: Record<string, string>): Promise<LoginView> {
    const value = await nonce(site)
    if (!value) return FAILED
    const result = await post('', { nonce: value, origin: site, ...fields })
    return loginView(result.status, result.body)
  }
  return {
    password: (site: string, username: string, password: string) => submit(site, { username, password }),
    code: (site: string, code: string) => submit(site, { code }),
    /** Read-only: the same outcome shape as the POST, for an attempt whose result was not in yet. */
    async recheck(attemptId: string): Promise<LoginView> {
      const result = await send(`/attempts/${encodeURIComponent(attemptId)}`, { method: 'GET' })
      const view = loginView(result.status, result.body)
      return 'attemptId' in view && !view.attemptId ? { ...view, attemptId } : view
    },
  }
}
