// Routes for connecting a workspace to an outside service (ADR ORV-30). The
// desktop asks the server for the GitHub App install URL; GitHub then sends
// the browser back to the callback, which records the installation.

export const INTEGRATION_ROUTES = {
  /**
   * POST `{ workspaceId }` with the desktop's JWT, owners and admins only.
   * Answers `{ url }`: the GitHub App installation page to open in a browser.
   */
  githubInstall: "/v1/integrations/github/install",
  /**
   * GET, opened by GitHub's setup redirect. The signed `state` names the
   * workspace and person; the server verifies the installation is this app's
   * and records it. No session: the browser carries no desktop cookie.
   */
  githubCallback: "/v1/integrations/github/callback",
  /** POST `{ workspaceId }` -> `{ url }` for Linear's app-actor consent. */
  linearConnect: "/v1/integrations/linear/connect",
  /**
   * POST `{ workspaceId, teamId, linearTeamId }` -> `{ url }`.
   * The callback creates that team's webhook with the admin grant and does
   * not store the token. Creating another webhook asks again.
   */
  linearAdmin: "/v1/integrations/linear/admin",
  /** GET, opened by Linear's OAuth redirect. No session: the signed state is the authentication. */
  linearCallback: "/v1/integrations/linear/callback",
  /** GET `?workspaceId=`. No tokens. Import progress is on `syncs`. */
  linearStatus: "/v1/integrations/linear/status",
  /** GET `?workspaceId=`. Linear teams the connected grant can see. */
  linearTeams: "/v1/integrations/linear/teams",
  /**
   * POST `{ workspaceId, teamId, linearTeamId, secret? }`.
   * Enables sync, then imports. Without `admin` on the stored app grant and
   * without `secret`, answers `{ outcome: "manual", webhookUrl }` and does
   * not enable. A one-time admin grant is the admin callback, not this route.
   */
  linearEnable: "/v1/integrations/linear/enable",
} as const

export interface LinearSyncProgress {
  teamId: string
  linearTeamId: string
  linearTeamKey: string
  enabled: boolean
  webhookMode: "auto" | "manual" | null
  importStatus: "idle" | "running" | "done" | "failed"
  importedCount: number
  importedCommentCount: number
  importError: string | null
}

/** What Settings reads. Tokens and the webhook secret are not on it. */
export interface LinearConnectionStatus {
  configured: boolean
  connected: boolean
  organizationName: string | null
  /** True when the stored app grant's scope includes `admin`. A personal admin token is not stored. */
  admin: boolean
  webhookUrl: string
  syncs: LinearSyncProgress[]
}

export interface LinearTeamOption {
  id: string
  key: string
  name: string
}

/** The provider id stored in `integration_connection`. */
export const GITHUB_INTEGRATION = "github"
