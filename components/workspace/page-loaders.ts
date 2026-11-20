import type { Cache, Key, useSWRConfig } from 'swr'
import { listAgents } from '@/app/actions/agents'
import { listBotsForWorkspace } from '@/app/actions/bots'
import { prefetchScopedRead } from '@/lib/swr/prefetch'
import { botPermissionsKeys } from '@/lib/swr/keys'

const loadTaskDetail = () => import('./task-detail')
export const loadAutomations = () => import('@/components/automations/automations-section').then(module => module.AutomationsSection)
export const loadCoordinator = () => import('@/components/coordinator/coordinator-chat').then(module => module.CoordinatorChat)
export const loadSettings = () => import('@/components/settings/settings-shell').then(module => module.SettingsRouteContent)

const loaders = { task: loadTaskDetail, automations: loadAutomations, coordinator: loadCoordinator, settings: loadSettings }
export type WorkspacePage = keyof typeof loaders

type ScopedMutate = ReturnType<typeof useSWRConfig>['mutate']
/** Where a page's speculative reads go: the open workspace's own cache, and the workspace they are scoped to. */
export type WorkspacePageReads = { cache: Cache; mutate: ScopedMutate; workspaceId: string }

/**
 * The reads a page's first paint waits on, with the same keys and the same reads the page uses.
 * Only reads that can start without something the page itself has to read first belong here: 设置 ›
 * 应用与运行权限 reads the workspace's Bots, then that Bot's workspace policy, then the run policy,
 * and only the first of those three can be asked for before the section is mounted.
 */
const reads: Partial<Record<WorkspacePage, (scope: WorkspacePageReads) => [Key, () => Promise<unknown>][]>> = {
  settings: ({ workspaceId }) => [
    [botPermissionsKeys.bots(workspaceId), () => listBotsForWorkspace(workspaceId)],
    [botPermissionsKeys.agents(), () => listAgents()],
  ],
}

/** Start the same module import used by the destination without mounting it, and its first reads beside it. */
export function preloadWorkspacePage(page: WorkspacePage, scope?: WorkspacePageReads) {
  void loaders[page]().catch(() => {})
  if (!scope) return
  for (const [key, read] of reads[page]?.(scope) ?? []) void prefetchScopedRead(scope.cache, scope.mutate, key, read)
}

export function preloadTaskDetail() { preloadWorkspacePage('task') }
