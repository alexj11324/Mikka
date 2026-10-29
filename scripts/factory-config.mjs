// Strict validation for the reviewed factory definition. The definition on main
// is the configuration authority; its digest pins a run to the exact version it
// started under. Secret values are never allowed here, only secret names.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { z } from 'zod'

const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'must be a lower-case identifier')
const positivePowerOfTwo = z.number().int().positive().refine(value => (value & (value - 1)) === 0, 'must be a power of two')

const repository = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  codeForge: z.enum(['github', 'gitlab']).optional(),
}).strict()

const runner = z.object({
  name: identifier,
  os: z.enum(['linux', 'macos', 'windows']),
  arch: z.enum(['x64', 'arm64']).optional(),
  instanceShape: z.object({
    vcpus: positivePowerOfTwo,
    memoryGb: positivePowerOfTwo,
  }).strict().optional(),
  dockerImage: z.string().min(1).optional(),
}).strict()

// A secret grant is a name. The strict object rejects any attempted value.
const secret = z.object({ name: identifier }).strict()

const harness = z.object({
  type: z.enum(['oz', 'claude', 'codex', 'claude-code']),
  model: z.string().min(1),
  reasoningLevel: z.string().min(1).optional(),
  auth: z.string().min(1).optional(),
}).strict()

const agentDefaults = z.object({
  model: z.string().min(1).optional(),
  harness: harness.optional(),
  runner: identifier.optional(),
  secrets: z.array(identifier).optional(),
  mcpServers: z.array(z.string().min(1)).optional(),
}).strict().refine(value => Boolean(value.model) !== Boolean(value.harness), 'agentDefaults must declare exactly one of model or harness')

export const factoryConfigSchema = z.object({
  schemaVersion: z.literal('v1alpha1'),
  name: identifier,
  repositories: z.array(repository),
  agentDefaults,
  credentialStrategy: z.enum(['creator', 'executor']).optional(),
  runners: z.array(runner).optional(),
  secrets: z.array(secret).optional(),
}).strict().superRefine((config, context) => {
  const runnerNames = new Set()
  for (const [index, entry] of (config.runners ?? []).entries()) {
    if (runnerNames.has(entry.name)) context.addIssue({ code: 'custom', path: ['runners', index, 'name'], message: `duplicate runner ${entry.name}` })
    runnerNames.add(entry.name)
  }
  const secretNames = new Set()
  for (const [index, entry] of (config.secrets ?? []).entries()) {
    if (secretNames.has(entry.name)) context.addIssue({ code: 'custom', path: ['secrets', index, 'name'], message: `duplicate secret ${entry.name}` })
    secretNames.add(entry.name)
  }
  if (config.agentDefaults.runner && !runnerNames.has(config.agentDefaults.runner)) {
    context.addIssue({ code: 'custom', path: ['agentDefaults', 'runner'], message: `unknown runner ${config.agentDefaults.runner}` })
  }
  for (const [index, name] of (config.agentDefaults.secrets ?? []).entries()) {
    if (!secretNames.has(name)) context.addIssue({ code: 'custom', path: ['agentDefaults', 'secrets', index], message: `unknown secret ${name}` })
  }
})

const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype'])
function assertSafeKeys(value, path = []) {
  if (Array.isArray(value)) { value.forEach((entry, index) => assertSafeKeys(entry, [...path, index])); return }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) throw new Error(`invalid factory config: forbidden key ${[...path, key].join('.')}`)
    assertSafeKeys(child, [...path, key])
  }
}

/** Parse YAML and validate it. Duplicate mapping keys fail closed (js-yaml default). */
export function parseFactoryConfig(source) {
  let parsed
  try {
    parsed = load(source)
  } catch (error) {
    throw new Error(`invalid YAML: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid factory config: root must be a mapping')
  assertSafeKeys(parsed)
  const result = factoryConfigSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
    throw new Error(`invalid factory config: ${issues}`)
  }
  return result.data
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]))
  }
  return value
}

/** SHA-256 of the canonical validated definition. Stable across key order and whitespace. */
export function factoryConfigDigest(config) {
  return createHash('sha256').update(JSON.stringify(canonical(config))).digest('hex')
}

export function readFactoryConfig(path) {
  const source = readFileSync(path, 'utf8')
  const config = parseFactoryConfig(source)
  return { config, source, digest: factoryConfigDigest(config) }
}
