-- #195: keep the delivery's immutable Factory ancestry while a new regression
-- after completion has its own local backlog item. No external write authority.
alter table factory_monitor_incidents add column if not exists "followupIssueId" uuid
  references issues(id) on delete set null;
