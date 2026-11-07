import { z } from 'zod'

export const SCIM_USER = 'urn:ietf:params:scim:schemas:core:2.0:User'
export const SCIM_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group'
export const SCIM_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
export const SCIM_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'
export class ScimError extends Error {
  constructor(readonly status: number, readonly scimType: string, readonly detail: string, options?: ErrorOptions) {
    super(detail, options); this.name = 'ScimError'
  }
}
const boundedString = z.string().trim().min(1).max(512)
const email = z.email().max(254).transform(value => value.toLowerCase())
export const scimUserInput = z.object({
  schemas: z.array(z.string()).refine(values => values.includes(SCIM_USER)),
  externalId: boundedString,
  userName: email,
  active: z.boolean().default(true),
  displayName: z.string().max(200).optional(),
  name: z.object({ givenName: z.string().max(200).optional(), familyName: z.string().max(200).optional(), formatted: z.string().max(200).optional() }).optional(),
  emails: z.array(z.object({ value: email, primary: z.boolean().optional(), type: z.string().max(50).optional() })).max(20).optional(),
}).strip()
export const scimGroupInput = z.object({
  schemas: z.array(z.string()).refine(values => values.includes(SCIM_GROUP)),
  externalId: boundedString.optional(),
  displayName: boundedString,
  members: z.array(z.object({ value: z.uuid(), display: z.string().max(200).optional(), '$ref': z.string().max(2048).optional() })).max(2000).default([]),
}).strip()
export type ScimUserDocument = z.infer<typeof scimUserInput>
export type ScimGroupDocument = z.infer<typeof scimGroupInput>
export function parseScim<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new ScimError(400, 'invalidValue', 'Invalid SCIM resource', { cause: result.error })
  return result.data
}

/** RFC 7644 equality subset advertised by ServiceProviderConfig; all other filters fail explicitly. */
export function scimQuery(url: URL, kind: 'Users' | 'Groups') {
  const startIndex = Number(url.searchParams.get('startIndex') ?? 1)
  const count = Number(url.searchParams.get('count') ?? 100)
  if (!Number.isInteger(startIndex) || startIndex < 1 || !Number.isInteger(count) || count < 0 || count > 200)
    throw new ScimError(400, 'invalidValue', 'Pagination is outside the supported range')
  const raw = url.searchParams.get('filter')
  let filter: { field: 'userName' | 'externalId' | 'displayName'; value: string } | undefined
  if (raw) {
    const match = /^(userName|externalId|displayName)\s+eq\s+("(?:[^"\\]|\\.)*")$/i.exec(raw)
    if (!match || (kind === 'Users' && match[1].toLowerCase() === 'displayname') || (kind === 'Groups' && match[1].toLowerCase() === 'username'))
      throw new ScimError(400, 'invalidFilter', 'Only equality filters on the documented attributes are supported')
    let value: unknown
    try { value = JSON.parse(match[2]) } catch (error) { throw new ScimError(400, 'invalidFilter', 'Invalid filter string', { cause: error }) }
    if (typeof value !== 'string' || value.length > 512) throw new ScimError(400, 'invalidFilter', 'Invalid filter value')
    const field = ({ username: 'userName', externalid: 'externalId', displayname: 'displayName' } as const)[match[1].toLowerCase() as 'username']
    filter = { field, value: field === 'userName' ? value.toLowerCase() : value }
  }
  return { startIndex, count, filter }
}

const patch = z.object({ schemas: z.array(z.string()).refine(values => values.includes(SCIM_PATCH)), Operations: z.array(z.object({
  op: z.string().transform(value => value.toLowerCase()).pipe(z.enum(['add', 'replace', 'remove'])), path: z.string().max(512).optional(), value: z.unknown().optional(),
})).min(1).max(100) })

/** Whitelisted SCIM paths avoid prototype assignment and unintended entitlement changes. */
export function applyScimPatch(kind: 'Users', document: ScimUserDocument, input: unknown): ScimUserDocument
export function applyScimPatch(kind: 'Groups', document: ScimGroupDocument, input: unknown): ScimGroupDocument
export function applyScimPatch(kind: 'Users' | 'Groups', document: ScimUserDocument | ScimGroupDocument, input: unknown) {
  const body = parseScim(patch, input)
  const next = structuredClone(document) as Record<string, unknown>
  for (const operation of body.Operations) {
    const path = operation.path?.replace(`${kind === 'Users' ? SCIM_USER : SCIM_GROUP}:`, '')
    const allowed = kind === 'Users' ? ['active', 'userName', 'displayName', 'name', 'emails', 'externalId'] : ['displayName', 'externalId', 'members']
    if (!path) {
      if (operation.op === 'remove' || !operation.value || typeof operation.value !== 'object' || Array.isArray(operation.value))
        throw new ScimError(400, 'invalidPath', 'A valid patch value is required')
      for (const [key, value] of Object.entries(operation.value)) {
        if (!allowed.includes(key)) throw new ScimError(400, 'invalidPath', 'Unsupported patch attribute')
        next[key] = value
      }
      continue
    }
    const selected = /^members\[value eq "([a-f0-9-]{36})"\]$/i.exec(path)
    if (kind === 'Groups' && selected && operation.op === 'remove') {
      next.members = (next.members as { value: string }[]).filter(member => member.value !== selected[1]); continue
    }
    if (!allowed.includes(path)) throw new ScimError(400, 'invalidPath', 'Unsupported patch attribute')
    if (operation.op === 'remove') {
      if (path === 'members') next.members = []
      else if (['displayName', 'name', 'emails'].includes(path)) delete next[path]
      else throw new ScimError(400, 'mutability', 'A required attribute cannot be removed')
    } else if (path === 'members' && operation.op === 'add') {
      const values = Array.isArray(operation.value) ? operation.value : [operation.value]
      next.members = [...(next.members as unknown[]), ...values]
    } else next[path] = operation.value
  }
  if (kind === 'Users') return parseScim(scimUserInput, next)
  const group = parseScim(scimGroupInput, next)
  group.members = [...new Map(group.members.map(member => [member.value, member])).values()]
  return group
}

export function scimResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/scim+json', 'cache-control': 'no-store', ...headers } })
}
export function scimFailure(error: unknown) {
  const known = error instanceof ScimError ? error : new ScimError(500, '', 'Provisioning failed')
  return scimResponse({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: String(known.status), ...(known.scimType ? { scimType: known.scimType } : {}), detail: known.detail }, known.status,
    known.status === 401 ? { 'www-authenticate': 'Bearer' } : {})
}
