-- target: MIKKA_DATABASE_URL
-- Workspace-added API-key models. A model a user adds to a workspace (a provider
-- API key, e.g. DeepSeek) can run any bot, the Coordinator included. The key is
-- handed to the Coordinator's model through the Vercel AI Gateway as a
-- request-scoped BYOK credential; the provider is the model id's prefix
-- (e.g. deepseek/deepseek-v4.1-flash -> deepseek). The key is sealed
-- (AES-256-GCM) in workspace_api_key_credentials; byos_connections /
-- byos_bindings carry only non-secret metadata (the gateway model id), so the
-- existing model menu, choice and freeze plumbing applies unchanged. A
-- credential never enters these columns.
begin;
set local lock_timeout = '5s';

alter table byos_connections drop constraint byos_connections_provider_check;
alter table byos_connections add constraint byos_connections_provider_check
  check (provider in ('codex', 'claude', 'apiKey'));

alter table byos_bindings drop constraint byos_bindings_route_check;
alter table byos_bindings add constraint byos_bindings_route_check
  check (route in ('codex_cpa', 'claude_cpa', 'codex_cli', 'claude_code_cli', 'api_key'));

create table if not exists workspace_api_key_credentials (
  "connectionId" uuid primary key references byos_connections(id) on delete cascade,
  "workspaceId" text not null,
  "providerSlug" text not null,
  ciphertext text not null,
  iv text not null,
  "keyVersion" integer not null,
  last4 text,
  "createdBy" text not null,
  "createdAt" timestamptz not null default now()
);
create index if not exists workspace_api_key_credentials_workspace_idx
  on workspace_api_key_credentials ("workspaceId");

commit;
