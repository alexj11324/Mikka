import { z } from 'zod'
import { normalizeRepository } from '@mikka/protocol/repository'

/**
 * A reusable run environment (lib/environments): the scripts and actions a
 * project's task machines run, versioned so a claimed run keeps the revision
 * it started with. Pure shapes only; storage is in store.ts / runs.ts.
 */
export const ENVIRONMENT_RUNTIMES = ['cloud', 'local'] as const
export type EnvironmentRuntime = (typeof ENVIRONMENT_RUNTIMES)[number]

export const ENVIRONMENT_ACTION_KINDS = ['run', 'dev', 'test', 'build'] as const
export type EnvironmentActionKind = (typeof ENVIRONMENT_ACTION_KINDS)[number]

export const RUN_ACTION_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out'] as const
export type RunActionStatus = (typeof RUN_ACTION_STATUSES)[number]

export const ENVIRONMENT_LIMITS = {
  /** Active environments per workspace, archived rows excluded. */
  environments: 50,
  name: 80,
  description: 600,
  /** UTF-8 bytes of each script. */
  scriptBytes: 4_000,
  workdir: 200,
  actions: 12,
  actionName: 40,
  command: 2_000,
  /** Seconds; the UI's default is one minute. */
  minTimeoutSeconds: 5,
  maxTimeoutSeconds: 900,
  defaultTimeoutSeconds: 120,
  repositories: 20,
  repository: 400,
  /** Each stream's stored bytes; older output is dropped, never truncated mid-line. */
  logBytes: 65_536,
} as const

const textBytes = (value: string) => new TextEncoder().encode(value).length

/** A relative directory under the run's worktree. The shell quoting in
 * environmentSetupCommand and the sandbox cwd both rely on this shape. */
export function safeRelativeWorkdir(value: string): boolean {
  if (!value) return true
  if (value.length > ENVIRONMENT_LIMITS.workdir || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false
  return value.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..' && /^[A-Za-z0-9._@+-]+$/.test(segment))
}

const workdirSchema = z.string().trim().max(ENVIRONMENT_LIMITS.workdir)
  .refine(safeRelativeWorkdir, { message: 'environment_workdir_invalid' })
const scriptSchema = z.string().max(ENVIRONMENT_LIMITS.scriptBytes * 4)
  .refine(value => textBytes(value) <= ENVIRONMENT_LIMITS.scriptBytes, { message: 'environment_script_too_large' })
const repositorySchema = z.string().trim().min(1).max(ENVIRONMENT_LIMITS.repository)
const actionFields = {
  id: z.uuid(),
  name: z.string().trim().min(1).max(ENVIRONMENT_LIMITS.actionName),
  kind: z.enum(ENVIRONMENT_ACTION_KINDS),
  command: z.string().trim().min(1).max(ENVIRONMENT_LIMITS.command),
  timeoutSeconds: z.number().int().min(ENVIRONMENT_LIMITS.minTimeoutSeconds).max(ENVIRONMENT_LIMITS.maxTimeoutSeconds),
}
const configFields = {
  name: z.string().trim().min(1).max(ENVIRONMENT_LIMITS.name),
  description: z.string().trim().max(ENVIRONMENT_LIMITS.description),
  runtime: z.enum(ENVIRONMENT_RUNTIMES),
  workdir: workdirSchema,
  setupScript: scriptSchema,
  installScript: scriptSchema,
  actions: z.array(z.strictObject(actionFields)).max(ENVIRONMENT_LIMITS.actions),
  repositories: z.array(repositorySchema).max(ENVIRONMENT_LIMITS.repositories),
}
type ConfigIssueContext = { addIssue: (issue: { code: 'custom'; message: string; path: (string | number)[] }) => void }
function refineConfig(value: { actions: { id: string }[]; repositories: string[] }, context: ConfigIssueContext) {
  if (new Set(value.actions.map(action => action.id)).size !== value.actions.length)
    context.addIssue({ code: 'custom', message: 'environment_action_duplicate', path: ['actions'] })
  if (new Set(value.repositories).size !== value.repositories.length)
    context.addIssue({ code: 'custom', message: 'environment_repository_duplicate', path: ['repositories'] })
}

export const environmentActionSchema = z.strictObject(actionFields)
export type EnvironmentAction = z.infer<typeof environmentActionSchema>

export const environmentConfigSchema = z.strictObject(configFields).superRefine(refineConfig)
export type EnvironmentConfig = z.output<typeof environmentConfigSchema>

export const environmentSaveInputSchema = z.strictObject({
  id: z.uuid().optional(),
  revision: z.number().int().positive().optional(),
  projectId: z.uuid().nullable(),
  isDefault: z.boolean(),
  config: environmentConfigSchema,
}).refine(value => !value.id || value.revision !== undefined, { message: 'environment_revision_required', path: ['revision'] })
export type EnvironmentSaveInput = z.input<typeof environmentSaveInputSchema>

export const environmentSnapshotSchema = z.strictObject({
  environmentId: z.uuid(),
  revision: z.number().int().positive(),
  ...configFields,
}).superRefine(refineConfig)
export type EnvironmentSnapshot = z.output<typeof environmentSnapshotSchema>

/** Accepts owner/repo, HTTPS and SSH remotes; the logical key is what storage
 * keeps, so two spellings of one repository cannot drift apart. */
export function normalizeEnvironmentRepositories(values: readonly string[]): string[] {
  return [...new Set(values.map(value => normalizeRepository(value).key))]
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** The one command a claim hands the daemon's existing approved-setup path.
 * Null when only a workdir is set: there is nothing to run. */
export function environmentSetupCommand(
  snapshot: Pick<EnvironmentSnapshot, 'workdir' | 'installScript' | 'setupScript'>,
): string | null {
  const scripts = [snapshot.installScript.trim(), snapshot.setupScript.trim()].filter(Boolean)
  if (!scripts.length) return null
  return ['set -e', ...(snapshot.workdir ? [`cd -- ${shellQuote(snapshot.workdir)}`] : []), ...scripts].join('\n')
}

/** The absolute cwd for a run action. Both inputs were validated on the way in. */
export function environmentActionCwd(worktreePath: string, workdir: string): string {
  if (!workdir) return worktreePath
  return `${worktreePath.replace(/\/+$/, '')}/${workdir}`
}

/** An empty allow-list means every repository the run was admitted with. */
export function environmentAllowsRepository(snapshot: Pick<EnvironmentSnapshot, 'repositories'>, repositoryKey: string): boolean {
  return snapshot.repositories.length === 0 || snapshot.repositories.includes(repositoryKey)
}

export function environmentActionFor(
  snapshot: Pick<EnvironmentSnapshot, 'actions'>,
  actionId: string,
): EnvironmentAction | null {
  return snapshot.actions.find(action => action.id === actionId) ?? null
}

export function isTerminalRunActionStatus(status: RunActionStatus): boolean {
  return status !== 'queued' && status !== 'running'
}

/** What the settings UI and the run-action API return. Never includes the
 * sandbox id or pid: those are execution internals. */
export type RunActionExecutionView = {
  id: string
  runId: string
  environmentId: string
  environmentRevision: number
  actionId: string
  actionName: string
  actionKind: EnvironmentActionKind
  command: string
  timeoutSeconds: number
  status: RunActionStatus
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  errorCode: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export type RunActionExecutionSummary = Omit<RunActionExecutionView, 'stdout' | 'stderr'>

/** Error codes an authenticated user can see in the environment API. The
 * settings UI maps each to Settings.environments.errors.* copy. */
export const ENVIRONMENT_ERROR_CODES = [
  'environmentNotFound',
  'environmentConflict',
  'environmentInvalid',
  'environmentNameTaken',
  'environmentLimitReached',
  'environmentPermissionDenied',
  'environmentProjectUnavailable',
  'environmentUnbound',
  'environmentActionNotFound',
  'environmentRepositoryNotAllowed',
  'environmentMachineUnsupported',
  'environmentActionBusy',
  'environmentUnavailable',
] as const
export type EnvironmentErrorCode = (typeof ENVIRONMENT_ERROR_CODES)[number]

export class EnvironmentRequestError extends Error {
  constructor(readonly code: EnvironmentErrorCode, readonly status = 400, options?: ErrorOptions) {
    super(code, options)
    this.name = 'EnvironmentRequestError'
  }
}
