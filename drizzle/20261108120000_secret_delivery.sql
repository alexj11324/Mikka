-- target: MIKKA_DATABASE_URL
-- ADR 2026-11-08-0240: existing and newly imported secrets become protected.
-- No plaintext value, automatic direct approval, or new encryption key is introduced.
-- kind=env keeps its existing direct behavior and ignores this metadata.
-- Rollback is intentionally not automatic: older runtime code exposes secret plaintext.

alter table workspace_secrets
  add column if not exists delivery jsonb not null default '{"mode":"protected"}'::jsonb;
alter table user_secrets
  add column if not exists delivery jsonb not null default '{"mode":"protected"}'::jsonb;

alter table workspace_secrets add constraint workspace_secrets_delivery_check check (
  coalesce(jsonb_typeof(delivery) = 'object' and delivery->>'mode' in ('protected', 'direct')
    and (delivery->>'mode' = 'protected' or (
      delivery @> '{"exposeToAgent":true}'::jsonb
      and jsonb_typeof(delivery->'approvedBy') = 'string' and length(delivery->>'approvedBy') > 0
      and jsonb_typeof(delivery->'approvedAt') = 'string' and length(delivery->>'approvedAt') > 0
    )), false)
);
alter table user_secrets add constraint user_secrets_delivery_check check (
  coalesce(jsonb_typeof(delivery) = 'object' and delivery->>'mode' in ('protected', 'direct')
    and (delivery->>'mode' = 'protected' or (
      delivery @> '{"exposeToAgent":true}'::jsonb
      and jsonb_typeof(delivery->'approvedBy') = 'string' and length(delivery->>'approvedBy') > 0
      and jsonb_typeof(delivery->'approvedAt') = 'string' and length(delivery->>'approvedAt') > 0
    )), false)
);
