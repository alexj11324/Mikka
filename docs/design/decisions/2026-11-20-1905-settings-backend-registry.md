# Registered settings and retained identifier authority

Source: Alex's backend task [#2956](https://github.com/alexj11324/Mikka/issues/2956).

Settings use one field registry and typed value columns. Null means personal
→ workspace → registry default inheritance. Existing actions keep their
contracts; archive and thread-title fields enter the registry incrementally.
The [backend contract](../../settings-backend/registry.md) owns the routes,
storage and reset semantics. The settings frontend remains owned by #2957.

## Issue prefixes

Keep the existing personal `issue_prefixes` and team `identifier` authorities.
Do not add a workspace prefix alongside them. The task has not specified
how existing task identifiers would migrate or which prefix would win; a
second authority would make task identity ambiguous.

## Role permission templates

Do not add role permission templates in this task. Existing resource approval
templates continue to mean resource approval, not organization roles. New
roles or permission templates require an explicit permission matrix. P7 uses
the existing admin/member roles and checks selected team scopes at acceptance.

## Other owners and exclusions

#2934 owns the cost ledger, #2935 thread summaries, and #2936 thread lifecycle.
Their contracts are consumed, not duplicated. Referral rewards, experiments,
cloud credentials/OIDC issuance and network restrictions remain out of scope.
New execution-resource contracts use `environment`, not a new project model.
