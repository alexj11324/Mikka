import { z } from 'zod'
import { setupRecipeSchema } from '@mikka/protocol/device'
import { isReservedEnvName, SECRET_NAME } from '@/lib/secrets/format'
import { MACHINE_SIZES, type MachineSize } from '@/lib/cloud-computer/machine-pricing'

/** The normalized key already used by device_repos, never a credential or a URL. */
export const projectRepositoryKey = z.string().trim().toLowerCase()
  .regex(/^v2\/[a-z0-9.-]+\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/)
  .refine(value => value.split('/').every(part => part !== '.' && part !== '..'))
export const projectBranch = z.string().trim().min(1).max(250)
  .refine(value => ![...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || '~^:?*[\\'.includes(char))
    && !value.includes('..') && !value.includes('@{') && !value.endsWith('.') && !value.endsWith('/') && !value.startsWith('-')
    && value.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock')))

const envName = z.string().regex(SECRET_NAME).refine(name => !isReservedEnvName(name))
export const environmentConfiguration = z.object({
  runtime: z.enum(['any', 'local', 'cloud']).default('any'),
  /** An official task harness constraint; this is not an independently provisioned machine. */
  harness: z.enum(['any', 'claude_code', 'codex', 'cursor']).default('any'),
  setup: setupRecipeSchema.optional(),
  variables: z.record(envName, z.string().max(32_768)).default({}),
  /** Existing encrypted workspace_secrets IDs. Values never enter this object or a Run snapshot. */
  secretIds: z.array(z.uuid()).max(100).default([]),
  repositoryKeys: z.array(projectRepositoryKey).max(100).default([]),
}).strict().refine(value => Object.keys(value.variables).length <= 100)
export type EnvironmentConfiguration = z.infer<typeof environmentConfiguration>
export const saveEnvironmentInput = z.object({
  workspaceId: z.uuid(), id: z.uuid().optional(), revision: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(120), configuration: environmentConfiguration,
  archived: z.boolean().default(false),
  /** The machine size runs in this Environment get by default; null is Mikka's default, absent keeps the saved one. */
  defaultMachineSize: z.enum(Object.keys(MACHINE_SIZES) as [MachineSize, ...MachineSize[]]).nullable().optional(),
}).strict()
export const repositoryBindingInput = z.object({
  repositoryKey: projectRepositoryKey, baseBranch: projectBranch.nullable().default(null),
  environmentId: z.uuid().nullable().default(null), isPrimary: z.boolean().default(false),
}).strict()
export const maxProjectRepositories = 100
const projectRepositoryAddition = z.object({
  repoFullName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i)
    .refine(name => {
      const repository = name.slice(name.indexOf('/') + 1)
      return repository !== '.' && repository !== '..' && !repository.startsWith('-') && !repository.toLowerCase().endsWith('.git')
    }),
  baseBranch: z.union([z.literal(''), projectBranch]).optional(),
  mode: z.enum(['primary', 'lazy']).optional(),
}).strict()
export const addProjectRepositoriesBody = z.object({ repos: z.array(projectRepositoryAddition).max(maxProjectRepositories) }).strict()

export const projectResourcesInput = z.object({
  workspaceId: z.uuid(), projectId: z.uuid(), revision: z.number().int().positive(),
  repositories: z.array(repositoryBindingInput).max(maxProjectRepositories),
  environmentIds: z.array(z.uuid()).max(100), defaultEnvironmentId: z.uuid().nullable(),
}).strict().refine(value => value.repositories.filter(item => item.isPrimary).length <= 1)
  .refine(value => new Set(value.repositories.map(item => item.repositoryKey)).size === value.repositories.length)
  .refine(value => !value.defaultEnvironmentId || value.environmentIds.includes(value.defaultEnvironmentId))
  .refine(value => value.repositories.every(item => !item.environmentId || value.environmentIds.includes(item.environmentId)))
export const projectResourceMutation = projectResourcesInput.or(
  addProjectRepositoriesBody.extend({ workspaceId: z.uuid(), projectId: z.uuid() }),
)
export const listDependencyRepositoriesInput = z.object({ workspaceId: z.uuid(), projectId: z.uuid() }).strict()
export const projectEnvironmentVariableInput = z.object({ workspaceId: z.uuid(), projectId: z.uuid(), name: envName }).strict()
export const projectPullAuthorInput = listDependencyRepositoriesInput.extend({
  readerId: z.string().min(1).max(128), repository: projectRepositoryKey, query: z.string().trim().min(1).max(39).regex(/^[A-Za-z0-9-]+$/),
})
export const replaceDependencyRepositoriesInput = listDependencyRepositoriesInput.extend({
  revision: z.number().int().positive(), repos: z.array(z.string().regex(/^[1-9][0-9]{0,29}$/)).max(100),
}).refine(input => new Set(input.repos).size === input.repos.length)
export const projectDefaultEnvironmentInput = z.object({
  workspaceId: z.uuid(), projectId: z.uuid(), revision: z.number().int().positive(),
  environmentId: z.uuid().nullable(),
}).strict()
export const projectSetupScope = z.object({
  workspaceId: z.uuid(), projectId: z.uuid(), environmentId: z.uuid(),
}).strict()
export const listProjectSetupVersionsInput = projectSetupScope.extend({ before: z.number().int().positive().optional() })
export const rollbackProjectSetupInput = projectSetupScope.extend({
  revision: z.number().int().positive(), version: z.number().int().positive(),
  bindingSnapshot: z.string().regex(/^[a-f0-9]{64}$/),
})
export type ProjectSetupRecipe = Omit<NonNullable<EnvironmentConfiguration['setup']>, 'approved'>
export type ProjectSetupHistory = {
  revision: number; totalProjects: number; bindingSnapshot: string
  versions: { revision: number; recordedAt: string; recipe: ProjectSetupRecipe | null }[]
  before: number | null
}

export const workspaceRepositoryPolicyInput = z.object({
  workspaceId: z.uuid(), revision: z.number().int().nonnegative(),
  mode: z.enum(['inherit', 'restricted']), repositoryKeys: z.array(projectRepositoryKey).max(500),
}).strict()

export interface ProjectExecutionSnapshot {
  version: 1
  workspaceId: string
  projectId: string | null
  projectRevision: number | null
  policyRevision: number
  repositoryKey: string | null
  baseBranch: string | null
  /** `chosen`: the run's request named it instead of the Project's default, so the thread's next runs keep it.
   * `defaultMachineSize`: the Environment's machine size when the run was admitted. */
  environment: ({ id: string; revision: number; name: string; chosen?: true; defaultMachineSize?: MachineSize } & EnvironmentConfiguration) | null
}
