import { SCIM_GROUP, SCIM_LIST, SCIM_USER, ScimError, scimFailure, scimQuery, scimResponse } from './scim-protocol'
import { type DirectoryGroup, type DirectoryUser, type ScimStore } from './scim-store'

const providerConfig = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
  patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 200 }, changePassword: { supported: false }, sort: { supported: false },
  etag: { supported: true }, authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Organization provisioning token', description: 'A rotated, connection-scoped bearer credential', primary: true }],
}
function resource(row: DirectoryUser | DirectoryGroup, kind: 'Users' | 'Groups', base: string) {
  return { ...row.document, id: row.id, ...(kind === 'Users' ? { active: (row as DirectoryUser).active } : {}), meta: {
    resourceType: kind === 'Users' ? 'User' : 'Group', created: row.createdAt.toISOString(), lastModified: row.updatedAt.toISOString(),
    location: `${base}/${kind}/${row.id}`, version: `W/"${row.revision}"`,
  } }
}
async function body(request: Request) {
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (type !== 'application/scim+json' && type !== 'application/json') throw new ScimError(415, '', 'A JSON request body is required')
  if (Number(request.headers.get('content-length') ?? 0) > 262144) throw new ScimError(413, 'tooMany', 'Request body is too large')
  const reader = request.body?.getReader()
  if (!reader) throw new ScimError(400, 'invalidSyntax', 'A JSON request body is required')
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > 262144) { await reader.cancel(); throw new ScimError(413, 'tooMany', 'Request body is too large') }
    chunks.push(next.value)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch (error) { throw new ScimError(400, 'invalidSyntax', 'Invalid JSON', { cause: error }) }
}

/** Used unchanged by the deployed route and isolated HTTP acceptance server. */
export function createScimHandler(store: ScimStore) {
  return async (request: Request, connectionId: string, path: string[]) => {
    try {
      const connection = await store.authenticate(connectionId, request.headers.get('authorization'))
      const url = new URL(request.url)
      const base = `${url.origin}${url.pathname.slice(0, url.pathname.indexOf(connectionId) + connectionId.length)}`
      const [kind, id, extra] = path
      if (extra) throw new ScimError(404, '', 'Resource not found')
      if (request.method === 'GET' && kind === 'ServiceProviderConfig' && !id) return scimResponse(providerConfig)
      if (request.method === 'GET' && kind === 'ResourceTypes' && !id) return scimResponse({ schemas: [SCIM_LIST], totalResults: 2, startIndex: 1, itemsPerPage: 2,
        Resources: [{ id: 'User', name: 'User', endpoint: '/Users', schema: SCIM_USER, schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'] },
          { id: 'Group', name: 'Group', endpoint: '/Groups', schema: SCIM_GROUP, schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'] }] })
      if (kind !== 'Users' && kind !== 'Groups') throw new ScimError(404, '', 'Resource not found')
      if (request.method === 'GET') {
        if (id) { const row = await store.get(connection, kind, id); return scimResponse(resource(row, kind, base), 200, { etag: `W/"${row.revision}"` }) }
        const query = scimQuery(url, kind)
        const { rows, totalResults } = await store.list(connection, kind, query)
        return scimResponse({ schemas: [SCIM_LIST], totalResults, startIndex: query.startIndex, itemsPerPage: rows.length, Resources: rows.map(row => resource(row, kind, base)) })
      }
      if (request.method === 'POST' && !id) {
        const input = await body(request)
        const result = kind === 'Users' ? await store.createUser(connection, input) : await store.createGroup(connection, input)
        const row = 'user' in result ? result.user : result.group
        return scimResponse(resource(row, kind, base), result.created ? 201 : 200, { location: `${base}/${kind}/${row.id}`, etag: `W/"${row.revision}"` })
      }
      if (id && (request.method === 'PUT' || request.method === 'PATCH')) {
        const input = await body(request)
        const row = kind === 'Users'
          ? await store.updateUser(connection, id, input, request.method === 'PATCH', request.headers.get('if-match'))
          : await store.updateGroup(connection, id, input, request.method === 'PATCH', request.headers.get('if-match'))
        return scimResponse(resource(row, kind, base), 200, { etag: `W/"${row.revision}"` })
      }
      if (id && request.method === 'DELETE') {
        if (kind === 'Users') await store.deleteUser(connection, id, request.headers.get('if-match'))
        else await store.deleteGroup(connection, id, request.headers.get('if-match'))
        return scimResponse(null, 204)
      }
      throw new ScimError(405, '', 'Method not allowed')
    } catch (error) { return scimFailure(error) }
  }
}
