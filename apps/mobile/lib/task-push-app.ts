import { Alert } from 'react-native'
import messages from '../../../messages/zh-CN.json'
import { api, saveWorkspace, savedWorkspace } from '@/lib/api'
import { apiCache } from '@/lib/api-cache'
import { currentAccount } from '@/lib/config'
import { openPush } from '@/lib/navigate'
import type { TaskPushTarget } from '@/lib/push-route'
import { readTaskInWorkspace, taskPushOpener } from '@/lib/task-push'
import type { Settings, TaskDetail } from '@/lib/types'

/** The selection the server has now, read fresh: the same read 设置 › 工作区 confirms a switch with. */
const currentWorkspace = async () => (await api<Settings>('/api/mobile/settings')).workspace.id

/** The app's lightweight prompt (as 网页打开未确认): the title only, with 重试 when the same push can be tried again. */
function unconfirmed(retry?: () => void) {
  const copy = messages.MobileServer
  Alert.alert(messages.MobileTaskPush.workspaceUnconfirmed, undefined, retry
    ? [{ text: copy.cancel, style: 'cancel' }, { text: copy.retry, onPress: retry }]
    : undefined)
}

const opener = taskPushOpener({
  current: currentWorkspace,
  save: saveWorkspace,
  owner: () => ({ account: currentAccount().id, context: apiCache.context() }),
  open: openPush,
  unconfirmed,
})

/** A tapped task push (lib/push.ts): confirm its workspace, then open the task (lib/task-push.ts). */
export function openTaskPush(target: TaskPushTarget) {
  void opener.open(target).catch(() => undefined)
}

/** A tapped push that names a workspace without a valid task target: refused, with the same feedback. */
export function refuseTaskPush() {
  opener.invalid()
}

/** The task screen's read when a push opened it: in the confirmed workspace only (lib/task-push.ts). */
export function readPushedTask(issueId: string, workspaceId: string) {
  return readTaskInWorkspace<TaskDetail>(issueId, workspaceId, {
    selected: () => savedWorkspace(),
    context: () => apiCache.context(),
    read: (path, headers) => api<TaskDetail>(path, { headers }),
  })
}
