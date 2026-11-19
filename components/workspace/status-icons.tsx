/*
 * The status glyphs `ISSUE_STATUSES` names, re-exported from the one mark registry
 * (`components/workspace/state-mark.tsx`, decision 2026-11-19-1600). They keep lucide's props so a call site that
 * passed `className` or `data-icon` still compiles: the size and the colour come from the status's own mark, which
 * is what every call site was spelling out by hand.
 */
export { STATUS_ICONS as STATUS_MARKS, STATUS_ICONS } from './state-mark'

import { STATUS_ICONS } from './state-mark'

/** 进行中: a ring, its right half filled. */
export const StatusProgressIcon = STATUS_ICONS.doing

/** 评审中: a ring, the work done as an arc around it. */
export const StatusReviewIcon = STATUS_ICONS.review

/** 已完成: a filled disc with the check cut out. */
export const StatusDoneIcon = STATUS_ICONS.done
