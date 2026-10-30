// Pure input rules for 设置 › 密钥与环境 (no DB, no server-only) so UI and tests share them.
import { z } from 'zod'
import { EGRESS_MODES, SECRET_ENVIRONMENTS } from '@/lib/db/secrets-schema'

export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
export const SECRET_VALUE_MAX_BYTES = 32 * 1024
export const REPOSITORY_REF = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
/** owner/repo; '.' and '..' are not valid segments. Stored and compared lowercase (GitHub names are case-insensitive). */
export const repositoryRef = z.string().trim().regex(REPOSITORY_REF).refine(ref => ref.split('/').every(part => part !== '.' && part !== '..'), 'dot segment').transform(ref => ref.toLowerCase())
export const EGRESS_DOMAINS_MAX = 200
export const EGRESS_INPUT_LINES_MAX = 5000
export const WORKSPACE_SECRETS_LIMIT = 500

const value = z.string().min(1).refine(text => Buffer.byteLength(text) <= SECRET_VALUE_MAX_BYTES, 'too large')
export const secretScope = z.discriminatedUnion('type', [
  z.object({ type: z.literal('workspace') }).strict(),
  z.object({ type: z.literal('repository'), repository: repositoryRef }).strict(),
])
export type SecretScope = z.infer<typeof secretScope>
export type SecretScopeType = SecretScope['type']
export { SECRET_ENVIRONMENTS }
export type SecretEnvironment = (typeof SECRET_ENVIRONMENTS)[number]
/** 'all' = every environment (and therefore production too). */
export const secretEnvironment = z.enum(SECRET_ENVIRONMENTS)

/** D6 新建: kind is chosen here only; edits (SEC-15～17) cannot change it. */
export const createSecretInput = z.object({
  name: z.string().trim().regex(SECRET_NAME),
  kind: z.enum(['secret', 'env']),
  value,
  scope: secretScope.default({ type: 'workspace' }),
  environment: secretEnvironment.default('all'),
}).strict()
/** SEC-15～17 编辑: new value; scope and environment may move too (omitted = unchanged). Kind and name are fixed. */
export const replaceSecretInput = z.object({ id: z.uuid(), value, scope: secretScope.optional(), environment: secretEnvironment.optional() }).strict()
export const deleteSecretInput = z.object({ id: z.uuid() }).strict()

export const scopeColumns = (scope: SecretScope) => scope.type === 'workspace'
  ? { scopeType: 'workspace' as const, scopeRef: '' }
  : { scopeType: 'repository' as const, scopeRef: scope.repository }

// One hostname per line: example.com or *.example.com (wildcard only as the whole first label).
const LABEL = '(?!-)[a-z0-9-]{1,63}(?<!-)'
const DOMAIN = new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})+$`)

// Bare IP addresses are not accepted (domains only for now). IPv6 never matches DOMAIN (':'),
// IPv4 would (digits are valid labels), so an all-numeric last label is rejected; no TLD is numeric.
const looksLikeIp = (host: string) => host.includes(':') || host.startsWith('[') || /\.\d+$/.test(host)

/**
 * Empty lines are dropped, then duplicates, then the rest is counted (`count`, checked against
 * EGRESS_DOMAINS_MAX by the caller). `invalid` holds 1-based line numbers of the original input.
 */
export function checkEgressDomains(lines: readonly string[]): { domains: string[]; invalid: number[]; count: number } {
  const domains: string[] = [], invalid: number[] = [], seen = new Set<string>()
  lines.forEach((line, i) => {
    const domain = line.trim().toLowerCase().replace(/\.$/, '')
    if (!domain || seen.has(domain)) return
    seen.add(domain)
    if (domain.length > 253 || looksLikeIp(domain) || !DOMAIN.test(domain)) invalid.push(i + 1)
    else domains.push(domain)
  })
  return { domains, invalid, count: seen.size }
}

export const updateEgressInput = z.object({
  mode: z.enum(EGRESS_MODES),
  // Hard input bound only; the 200-domain rule is egressTooManyDomains with the real count.
  allowedDomains: z.array(z.string().max(300)).max(EGRESS_INPUT_LINES_MAX).default([]),
}).strict()

export const e2bKeyInput = z.object({ apiKey: z.string().trim().min(8).max(200).regex(/^\S+$/) }).strict()
