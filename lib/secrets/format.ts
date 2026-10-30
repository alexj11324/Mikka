// Pure input rules for 设置 › 密钥与环境 (no DB, no server-only) so UI and tests share them.
import { z } from 'zod'

export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
/**
 * Names the runtime owns, or that make a shell / interpreter / package manager run or fetch something on start.
 * Rejected on create (secretNameReserved). This PR has no injection point; the runtime filter (skip + audit,
 * name only) lands with injection in #438 / 4e3 (lib/secrets/runtime.ts).
 * Case-insensitive. Includes every variable the hosted worker/runner sets for itself.
 */
export const RESERVED_ENV_NAME = /^(?:PATH|HOME|SHELL|USER|LOGNAME|PWD|TMPDIR|TERM|NODE_OPTIONS|NODE_PATH|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|NODE_USE_ENV_PROXY|SSL_CERT_.*|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|LD_.*|DYLD_.*|PYTHONPATH|PYTHONHOME|GIT_.*|SSH_.*|E2B_.*|MIKKA_.*|DOCKER_.*|INFISICAL_.*|WORKSPACE_SECRETS_KEY|CLAUDE_CODE_.*|CODEX_.*|ANTHROPIC_BASE_URL|OPENAI_BASE_URL|DATABASE_URL|BASH_ENV|ENV|PROMPT_COMMAND|PERL5OPT|RUBYOPT|JAVA_TOOL_OPTIONS|NPM_CONFIG_.*|PIP_INDEX_URL|PYTHONSTARTUP|GLOBAL_AGENT_HTTP_PROXY)$/i
export const isReservedEnvName = (name: string) => RESERVED_ENV_NAME.test(name)
export const SECRET_VALUE_MAX_BYTES = 32 * 1024
export const REPOSITORY_REF = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
/** owner/repo; '.' and '..' are not valid segments. Stored and compared lowercase (GitHub names are case-insensitive). */
export const repositoryRef = z.string().trim().regex(REPOSITORY_REF).refine(ref => ref.split('/').every(part => part !== '.' && part !== '..'), 'dot segment').transform(ref => ref.toLowerCase())
export const WORKSPACE_SECRETS_LIMIT = 500

const value = z.string().min(1).refine(text => Buffer.byteLength(text) <= SECRET_VALUE_MAX_BYTES, 'too large')
export const secretScope = z.discriminatedUnion('type', [
  z.object({ type: z.literal('workspace') }).strict(),
  z.object({ type: z.literal('repository'), repository: repositoryRef }).strict(),
])
export type SecretScope = z.infer<typeof secretScope>
export type SecretScopeType = SecretScope['type']

/** D6 新建: kind is chosen here only; edits (SEC-15～17) cannot change it. */
export const createSecretInput = z.object({
  name: z.string().trim().regex(SECRET_NAME),
  kind: z.enum(['secret', 'env']),
  value,
  scope: secretScope.default({ type: 'workspace' }),
}).strict()
/** SEC-15～17 编辑: new value; scope may move too (omitted = unchanged). Kind and name are fixed. */
export const replaceSecretInput = z.object({ id: z.uuid(), value, scope: secretScope.optional() }).strict()
export const deleteSecretInput = z.object({ id: z.uuid() }).strict()

export const scopeColumns = (scope: SecretScope) => scope.type === 'workspace'
  ? { scopeType: 'workspace' as const, scopeRef: '' }
  : { scopeType: 'repository' as const, scopeRef: scope.repository }

export const e2bKeyInput = z.object({ apiKey: z.string().trim().min(8).max(200).regex(/^\S+$/) }).strict()
