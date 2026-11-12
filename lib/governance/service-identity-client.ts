import { withBasePath } from '@/lib/base-path'

export type ServiceIdentityRow = { id: string; workspaceId: string; name: string; enabled: boolean; revision: number }
export type ServiceIdentityPage = { identities: ServiceIdentityRow[]; nextCursor: string | null }
export type ServiceCredentialState = { enabled: boolean; revision: number; configured: boolean; expiresAt: string | null }
type IdentityChange = { action: 'rename'; name: string } | { action: 'disable' | 'restore' }

export class ServiceIdentityRequestError extends Error {
  constructor(public readonly status: number, public readonly detail?: string) {
    super('Service identity request failed')
  }
}

/** Fetch on the selected Mikka server. One-time service keys are returned to the caller only. */
export function serviceIdentityClient(workspaceId: string) {
  const base = withBasePath('/api/workspaces/' + encodeURIComponent(workspaceId) + '/service-identities')
  const item = (id: string) => '/' + encodeURIComponent(id)
  async function request<T>(suffix: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(base + suffix, {
      method, cache: 'no-store', credentials: 'same-origin',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      const data = await response.json().catch(() => null)
      throw new ServiceIdentityRequestError(response.status, data?.error?.detail)
    }
    return response.json()
  }
  return {
    list: (after?: string) => request<ServiceIdentityPage>(after ? '?after=' + encodeURIComponent(after) : ''),
    create: (name: string, requestId: string) => request<ServiceIdentityRow>('', 'POST', { name, requestId }),
    get: (id: string) => request<ServiceIdentityRow>(item(id)),
    change: (row: ServiceIdentityRow, change: IdentityChange) =>
      request<ServiceIdentityRow>(item(row.id), 'PATCH', { revision: row.revision, ...change }),
    projects: (id: string) => request<{ projectIds: string[] }>(item(id) + '/projects'),
    choices: (id: string, after?: string) => request<{ projects: { id: string; name: string }[]; nextCursor: string | null }>(
      item(id) + '/projects?view=choices' + (after ? '&after=' + encodeURIComponent(after) : ''),
    ),
    replaceProjects: (id: string, expectedProjectIds: string[], projectIds: string[], confirmExpansion: boolean) =>
      request<{ projectIds: string[] }>(item(id) + '/projects', 'PUT', { expectedProjectIds, projectIds, confirmExpansion }),
    credential: (id: string) => request<ServiceCredentialState>(item(id) + '/credential'),
    rotate: (id: string, revision: number, expiresAt: string | null) =>
      request<ServiceCredentialState & { token: string }>(item(id) + '/credential', 'POST', { action: 'rotate', revision, expiresAt }),
    revoke: (id: string, revision: number) =>
      request<ServiceCredentialState>(item(id) + '/credential', 'POST', { action: 'revoke', revision }),
  }
}
