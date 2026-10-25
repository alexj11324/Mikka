-- Indexes for the task list. listIssues, the MCP tools and issue numbering
-- filter issues by owner ("userId") and sort by "updatedAt"; the only existing
-- owner index is partial (scope corrections). Shared tasks are found through
-- issue_members by "memberId", which the ("issueId", "memberId") key cannot serve.
-- Mirrors lib/db/schema.ts. Safe to run again.
create index if not exists issues_owner_updated_idx on issues ("userId", "updatedAt" desc);
create index if not exists issue_members_member_idx on issue_members ("memberId", "issueId");
