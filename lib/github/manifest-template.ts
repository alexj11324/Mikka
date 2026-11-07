import type { GitHubAppTemplate } from './manifest'

// #1563 staging checkpoint: replace this with the verified permissions/events
// returned by the existing official App. Anonymous App lookup is unavailable;
// deployments can read their own App through the server-admin-only metadata
// endpoint. Never guess permissions or fetch Mikka metadata during creation.
export const GITHUB_APP_MANIFEST_TEMPLATE: GitHubAppTemplate | null = null
