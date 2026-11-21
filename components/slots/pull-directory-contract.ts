// What the pull-directory slot receives (docs/ui-overlay.md, decision 2026-11-19-2120):
// the PR directory page under `?section=pulls`. Reads and writes stay in the
// public core: listConversations (linked PRs, Project and Created conditions),
// /api/integrations/github/repositories/pulls (a repository's PRs, `since`),
// pulls/detail and pulls/merge (one PR, linked or not), and app/actions/list-views
// (pins and `pulls` saved views, which follow the person across devices).
// `pull=owner/name/number` in the address is a PR's own page ("Open in new tab").
export type PullDirectoryProps = {
  ownerId: string
  workspaceId: string | null
  /** The rail's Bot filter: only PRs from that Bot's threads. */
  botId: string | null
  /** Bumped when the thread list changes, so the linked list reads again. */
  revision?: number
}
