import type { Href } from 'expo-router'

/** The review screen (R2) and a file's diff (R3) of a task. */
export const reviewHref = (taskId: string): Href => ({ pathname: '/task/[id]/review', params: { id: taskId } })
export const fileHref = (taskId: string, path: string): Href => ({ pathname: '/task/[id]/file', params: { id: taskId, path } })
