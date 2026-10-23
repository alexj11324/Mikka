create index if not exists issues_owner_updated_idx on issues ("userId", "updatedAt" desc);
create index if not exists issue_members_member_idx on issue_members ("memberId", "issueId");
create index if not exists issue_versions_issue_revision_idx on issue_versions ("issueId", "userId", revision desc);
