/** The pull_request actions that can change what a delivery stores (title, state, draft, line counts) or its PR
 * badge (new commits restart its checks). Labels, assignees, reviewers and the like change neither (#1212).
 * Import-free, so the webhook route can drop other actions before loading the database. */
export const PULL_REQUEST_REFRESH_ACTIONS: ReadonlySet<string> = new Set(['opened', 'reopened', 'closed', 'edited', 'synchronize', 'ready_for_review', 'converted_to_draft'])
