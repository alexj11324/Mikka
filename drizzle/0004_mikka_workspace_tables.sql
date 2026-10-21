-- target: DATABASE_URL
-- Orvilo -> Mikka: rename the workspace tables in the workspace database
-- (DATABASE_URL, not MIKKA_DATABASE_URL). Run BEFORE deploying the code that
-- reads mikka_* tables. The orvilo_* views keep the previous deployment
-- working (simple views are updatable) until it is replaced; drop them after.
-- Applied by scripts/migrate.mjs on production builds.

begin;
alter table if exists orvilo_workspaces rename to mikka_workspaces;
alter table if exists orvilo_workspace_members rename to mikka_workspace_members;
alter table if exists orvilo_workspace_invitations rename to mikka_workspace_invitations;
do $$
begin
  -- Only where the tables exist; a database that never had them is left alone.
  if to_regclass('mikka_workspaces') is not null then
    create or replace view orvilo_workspaces as select * from mikka_workspaces;
  end if;
  if to_regclass('mikka_workspace_members') is not null then
    create or replace view orvilo_workspace_members as select * from mikka_workspace_members;
  end if;
  if to_regclass('mikka_workspace_invitations') is not null then
    create or replace view orvilo_workspace_invitations as select * from mikka_workspace_invitations;
  end if;
end $$;
commit;

-- Once the Mikka deployment is live:
-- drop view orvilo_workspaces, orvilo_workspace_members, orvilo_workspace_invitations;
