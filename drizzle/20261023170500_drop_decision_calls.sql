-- The decision model's spend is now capped by the Vercel budget on its own AI
-- Gateway key (DECISION_GATEWAY_API_KEY), so the app no longer keeps a ledger.
-- Applied by scripts/migrate.mjs on production builds.

drop table if exists decision_calls;
