import { api, saveWorkspace, savedWorkspace } from '@/lib/api'
import { apiCache } from '@/lib/api-cache'
import { openPush } from '@/lib/navigate'
import type { TaskPushTarget } from '@/lib/push-route'
import { readTaskInWorkspace, taskPushOpener } from '@/lib/task-push'
import type { Settings, TaskDetail } from '@/lib/types'

/** The selection the server has now, read fresh: the same read 设置 › 工作区 confirms a switch with. */
const currentWorkspace = async () => (await api<Settings>('/api/mobile/settings')).workspace.id

const open = taskPushOpener({ current: currentWorkspace, save: saveWorkspace, context: () => apiCache.context(), open: openPush })

/** A tapped task push (lib/push.ts): confirm its workspace, then open the task (lib/task-push.ts). */
export function openTaskPush(target: TaskPushTarget) {
  void open(target).catch(() => undefined)
}

/** The task screen's read when a push opened it: in the confirmed workspace only (lib/task-push.ts). */
export function readPushedTask(issueId: string, workspaceId: string) {
  return readTaskInWorkspace<TaskDetail>(issueId, workspaceId, {
    selected: () => savedWorkspace(),
    context: () => apiCache.context(),
    read: (path, headers) => api<TaskDetail>(path, { headers }),
  })
}
