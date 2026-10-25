-- target: DATABASE_URL
-- Orvilo -> Mikka: rename the team tables, their constraints and the
-- workspace slug index. Safe to run again: each step checks the old name.
do $$
declare
  t text;
  c record;
begin
  foreach t in array array['teams', 'team_members', 'team_issues', 'team_projects'] loop
    if to_regclass('orvilo_' || t) is not null and to_regclass('mikka_' || t) is null then
      execute format('alter table %I rename to %I', 'orvilo_' || t, 'mikka_' || t);
    end if;
  end loop;

  for c in
    select con.conname, rel.relname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = current_schema()
      and rel.relname in ('mikka_teams', 'mikka_team_members', 'mikka_team_issues', 'mikka_team_projects')
      and con.conname like 'orvilo\_%'
  loop
    execute format('alter table %I rename constraint %I to %I', c.relname, c.conname, 'mikka_' || substr(c.conname, 8));
  end loop;
end $$;

alter index if exists orvilo_workspaces_slug_unique rename to mikka_workspaces_slug_unique;
