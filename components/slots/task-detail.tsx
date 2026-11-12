import type { TaskDetailFrameProps } from './task-detail-contract'

/** The official renderer provides this required slot. Server builds need only its contract. */
export function TaskDetailFrame(_props: TaskDetailFrameProps): never {
  throw new Error('Required official UI slot task-detail.TaskDetailFrame is unavailable')
}
