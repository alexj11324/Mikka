import type { Href } from 'expo-router'

/** The review screen (R2) and a file's diff (R3) of a task. */
export const reviewHref = (taskId: string): Href => ({ pathname: '/task/[id]/review', params: { id: taskId } })
export const fileHref = (taskId: string, path: string): Href => ({ pathname: '/task/[id]/file', params: { id: taskId, path } })
/** The review's sheets: the pending batch and R2b's note. */
export const batchHref = (taskId: string): Href => ({ pathname: '/task/[id]/batch', params: { id: taskId } })
export const noteHref = (taskId: string): Href => ({ pathname: '/task/[id]/note', params: { id: taskId } })
