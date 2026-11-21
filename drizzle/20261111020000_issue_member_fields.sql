-- Task membership carried only "is this account a member". Three facts the
-- collaboration model needs are missing (ALE-29), and all three are columns:
--
--   role       who may invite and change visibility, not only the task's owner
--   subscribed whether a member hears about the task, without leaving it
--   invitedBy  who added this member, once more than one account can invite
--
-- Existing rows keep today's meaning: every current member was added by the
-- task's owner and hears about the task, so the owner is the backfill for
-- "invitedBy" and true for "subscribed". No row changes hands, and no code
-- reads the new columns as authority until it is changed to.
alter table issue_members
  add column if not exists role text not null default 'member'
    check (role in ('owner', 'member')),
  add column if not exists subscribed boolean not null default true,
  add column if not exists "invitedBy" text;

-- The inviting account, for every row that predates this migration. Nullable:
-- a membership may have no recorded inviter (a system or a task transfer), and
-- an unknown inviter is honest, while a guessed one would not be. The backfill
-- runs once, for rows the column never covered.
update issue_members m
  set "invitedBy" = i."userId"
  from issues i
  where i.id = m."issueId" and m."invitedBy" is null;
