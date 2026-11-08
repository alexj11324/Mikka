'use client'

import { useCallback, useState } from 'react'
import useSWR, { unstable_serialize } from 'swr'
import { getReviewChecks, getReviewDiff, getReviewFile } from '@/lib/code-review/client'
import type { ReviewCheck, ReviewFile, ReviewFileRead, ReviewRead } from '@/lib/code-review/contract'
import { reviewKeys, useReviewLive } from './review-keys'

/**
 * The review page's read (R1): the summary and the whole PR's diff, base…head (decision 3). `commit` is
 * 按提交筛选. Large changes come a page of files at a time; `loadMore` appends the next page. A live refresh
 * re-reads the first page and drops the pages loaded after it.
 */
export function useReviewDiff(taskId: string | null | undefined, options: { commit?: string | null } = {}) {
  const commit = options.commit ?? null
  const key = taskId ? reviewKeys.review(taskId, commit) : null
  const result = useSWR<ReviewRead>(key, ([, id, at]: readonly [string, string, string | null]) => getReviewDiff(id, { commit: at ?? undefined }), {
    revalidateOnFocus: false, revalidateOnReconnect: true, shouldRetryOnError: false,
  })
  useReviewLive(taskId ?? null, result.data?.summary.live?.workspaceId, key ? [unstable_serialize(key)] : [])
  const [pages, setPages] = useState<{ after: ReviewRead; files: ReviewFile[]; nextCursor?: string } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const first = result.data
  const extra = pages && pages.after === first ? pages : null
  const nextCursor = extra ? extra.nextCursor : first?.diff.nextCursor
  const loadMore = useCallback(async () => {
    if (!taskId || !first || !nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await getReviewDiff(taskId, { cursor: nextCursor, commit: commit ?? undefined })
      setPages(current => ({ after: first, files: [...(current?.after === first ? current.files : []), ...page.diff.files], nextCursor: page.diff.nextCursor }))
    } finally { setLoadingMore(false) }
  }, [taskId, first, nextCursor, loadingMore, commit])
  const files = first ? [...first.diff.files, ...(extra?.files ?? [])] : []
  return { ...result, files, nextCursor, loadMore, loadingMore }
}

/** One file's patch, for a file paged out or too large (R12 「按文件加载」); null path reads nothing. */
export function useReviewFile(taskId: string | null | undefined, path: string | null, head: string | null) {
  return useSWR<ReviewFileRead>(taskId && path && head ? reviewKeys.file(taskId, path, head) : null, ([, id, file]: readonly [string, string, string, string]) => getReviewFile(id, file), {
    revalidateOnFocus: false, shouldRetryOnError: false,
  })
}

/** The checks behind the check summary (R1b), read when it expands. */
export function useReviewChecks(taskId: string | null | undefined, enabled = true) {
  const key = taskId && enabled ? reviewKeys.checks(taskId) : null
  const result = useSWR<ReviewCheck[]>(key, ([, id]: readonly [string, string]) => getReviewChecks(id), {
    revalidateOnFocus: false, shouldRetryOnError: false,
  })
  return result
}
