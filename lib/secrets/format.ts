// Pure input rules for 设置 › 密钥与环境 (no DB, no server-only) so UI and tests share them.
import { z } from 'zod'
import { EGRESS_MODES } from '@/lib/db/secrets-schema'

export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
export const SECRET_VALUE_MAX_BYTES = 32 * 1024
export const REPOSITORY_REF = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
export const EGRESS_DOMAINS_MAX = 200
export const WORKSPACE_SECRETS_LIMIT = 500

const value = z.string().min(1).refine(text => Buffer.byteLength(text) <= SECRET_VALUE_MAX_BYTES, 'too large')
export const secretScope = z.discriminatedUnion('type', [
  z.object({ type: z.literal('workspace') }).strict(),
  z.object({ type: z.literal('repository'), repository: z.string().regex(REPOSITORY_REF) }).strict(),
])
export type SecretScope = z.infer<typeof secretScope>

/** D6 新建: kind is chosen here only; edits (SEC-15～17) cannot change it. */
export const createSecretInput = z.object({
  name: z.string().trim().regex(SECRET_NAME),
  kind: z.enum(['secret', 'env']),
  value,
  scope: secretScope.default({ type: 'workspace' }),
}).strict()
export const replaceSecretInput = z.object({ id: z.uuid(), value }).strict()
export const deleteSecretInput = z.object({ id: z.uuid() }).strict()

export const scopeColumns = (scope: SecretScope) => scope.type === 'workspace'
  ? { scopeType: 'workspace' as const, scopeRef: '' }
  : { scopeType: 'repository' as const, scopeRef: scope.repository }

// One hostname per line: example.com or *.example.com (wildcard only as the whole first label).
const LABEL = '(?!-)[a-z0-9-]{1,63}(?<!-)'
const DOMAIN = new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})+$`)

/** Normalised domains plus the 0-based indexes of lines that are not valid hostnames. */
export function checkEgressDomains(lines: readonly string[]): { domains: string[]; invalid: number[] } {
  const domains: string[] = [], invalid: number[] = []
  lines.forEach((line, i) => {
    const domain = line.trim().toLowerCase().replace(/\.$/, '')
    if (!domain) return
    if (domain.length > 253 || !DOMAIN.test(domain)) invalid.push(i)
    else if (!domains.includes(domain)) domains.push(domain)
  })
  return { domains, invalid }
}

export const updateEgressInput = z.object({
  mode: z.enum(EGRESS_MODES),
  allowedDomains: z.array(z.string().max(300)).max(EGRESS_DOMAINS_MAX).default([]),
}).strict()

export const e2bKeyInput = z.object({ apiKey: z.string().trim().min(8).max(200).regex(/^\S+$/) }).strict()
