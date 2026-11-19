const loadTaskDetail = () => import('./task-detail')
export const loadAutomations = () => import('@/components/automations/automations-section').then(module => module.AutomationsSection)
export const loadCoordinator = () => import('@/components/coordinator/coordinator-chat').then(module => module.CoordinatorChat)
export const loadSettings = () => import('@/components/settings/settings-shell').then(module => module.SettingsRouteContent)

const loaders = { task: loadTaskDetail, automations: loadAutomations, coordinator: loadCoordinator, settings: loadSettings }
export type WorkspacePage = keyof typeof loaders

/** Start the same module import used by the destination without mounting it. */
export function preloadWorkspacePage(page: WorkspacePage) {
  void loaders[page]().catch(() => {})
}

export function preloadTaskDetail() { preloadWorkspacePage('task') }
