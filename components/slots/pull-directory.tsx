'use client'

/**
 * The PR directory (`?section=pulls`). The open-source UI draws the shared
 * directory; a UI layer may draw its own from the same props and reads
 * (docs/ui-overlay.md, decision 2026-11-19-2120).
 */
import { PullDirectory } from '@/components/workspace/pull-directory'
import type { PullDirectoryProps } from './pull-directory-contract'

export function PullDirectoryPage(props: PullDirectoryProps) {
  return <PullDirectory {...props} />
}
