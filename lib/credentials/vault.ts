import { CredentialError } from './contracts'

/** The sole interface allowed to receive and return plaintext. Never expose to tools. */
export interface CredentialVault {
  put(ref: string, secret: string): Promise<void>
  read(ref: string): Promise<string>
  remove(ref: string): Promise<void>
}

export class InfisicalCredentialVault implements CredentialVault {
  constructor(private readonly config: {
    origin: string; projectId: string; environment: string; secretPath: string;
    accessToken: () => Promise<string>; rejectAccessToken?: (token: string) => void; fetch?: typeof fetch
    onFailure?: (failure: VaultFailure) => void
  }) {
    const url = new URL(config.origin)
    if (url.protocol !== 'https:' || url.origin !== config.origin || !config.projectId || !config.environment ||
      !/^\/[a-zA-Z0-9/_-]+$/.test(config.secretPath)) throw new CredentialError('vault_configuration_invalid', 503)
  }

  private async call(method: string, ref: string, secret?: string) {
    if (!/^[0-9a-f-]{36}$/.test(ref)) throw new CredentialError('vault_reference_invalid', 503)
    const url = new URL(`/api/v4/secrets/MIKKA_CREDENTIAL_${ref.replaceAll('-', '')}`, this.config.origin)
    const scope = { projectId: this.config.projectId, environment: this.config.environment, secretPath: this.config.secretPath, type: 'shared' }
    if (method === 'GET') url.search = new URLSearchParams({ ...scope, expandSecretReferences: 'false', viewSecretValue: 'true' }).toString()
    let stage: VaultFailure['stage'] = 'authentication'
    let status: number | undefined
    try {
      const token = await this.config.accessToken()
      stage = 'request'
      const response = await (this.config.fetch ?? fetch)(url, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(method !== 'GET' ? { body: JSON.stringify({ ...scope, ...(secret === undefined ? {} : { secretValue: secret, skipMultilineEncoding: true }) }) } : {}),
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
      })
      status = response.status
      if (response.status === 401 || response.status === 403) this.config.rejectAccessToken?.(token)
      if (method === 'DELETE' && response.status === 404) { await response.body?.cancel(); return undefined }
      if (!response.ok) { await response.body?.cancel(); throw new Error() }
      if (method !== 'GET') { await response.body?.cancel(); return undefined }
      const body = await response.json()
      if (typeof body?.secret?.secretValue !== 'string' || !body.secret.secretValue || body.secret.secretValue.length > 8192 || /[\r\n\0]/.test(body.secret.secretValue)) throw new Error()
      return body.secret.secretValue as string
    } catch {
      // Only fixed enums and numeric HTTP status reach diagnostics. Never pass
      // request/response/error objects, references, credentials or provider text.
      try { this.config.onFailure?.({ stage, kind: status === undefined ? 'unavailable' : 'http', ...(status === undefined ? {} : { status }) }) } catch { /* Diagnostics cannot change failure semantics. */ }
      // Provider errors can contain a request, response body, token or secret. Discard cause.
      throw new CredentialError('vault_unavailable', 503)
    }
  }
  async put(ref: string, secret: string) { await this.call('POST', ref, secret) }
  async read(ref: string) { return (await this.call('GET', ref))! }
  async remove(ref: string) { await this.call('DELETE', ref) }
}
