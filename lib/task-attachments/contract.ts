/** One upload fits the hosted request body limit, including the API proxy. */
export const TASK_FILE_MAX_BYTES = 3 * 1024 * 1024
export const TASK_FILE_MAX_COUNT = 10
export type TaskFile = { id: string; name: string; size: number }
export type TaskFileList = { files: TaskFile[]; canEdit: boolean }

/** Relative to the lookup endpoint so cloud and self-hosted installations keep their own mount path. */
export function taskFileDownloadReference(taskId: string, fileId: string) {
  return `../${encodeURIComponent(taskId)}/attachments?id=${encodeURIComponent(fileId)}`
}
