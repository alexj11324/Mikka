import type { GitHubAppTemplate } from './manifest'

// Authenticated official mikka-github GET /app snapshot, 2026-11-07T11:43:44.314Z.
// OIDC/Infisical Actions run 42369222955, job 128393675936; see docs/github-app-manifest.md.
// Bundled baseline metadata only: creating a self-hosted App never calls the official App.
// check_suite and status below are additive subscriptions for NEW Apps only;
// this file does not change the existing official App's live webhook events.
export const GITHUB_APP_MANIFEST_TEMPLATE: GitHubAppTemplate = {
  "permissions": {
    "actions": "write",
    "administration": "read",
    "checks": "read",
    "contents": "write",
    "deployments": "read",
    "discussions": "write",
    "emails": "read",
    "gists": "write",
    "issues": "write",
    "members": "read",
    "merge_queues": "read",
    "metadata": "read",
    "organization_projects": "write",
    "pull_requests": "write",
    "repository_advisories": "read",
    "repository_custom_properties": "read",
    "repository_projects": "write",
    "secret_scanning_alerts": "read",
    "security_events": "read",
    "starring": "write",
    "statuses": "read",
    "vulnerability_alerts": "read",
    "workflows": "write"
  },
  "events": [
    "check_suite",
    "deployment_protection_rule",
    "issues",
    "issue_comment",
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
    "status"
  ]
}
