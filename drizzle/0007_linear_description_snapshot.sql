-- Keep the provider description baseline so metadata-only webhooks do not rewrite rich-text details.

alter table linear_issue_links add column if not exists "linearDescriptionHash" text;
