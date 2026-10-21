-- Orvilo -> Mikka: move issue card metadata from content.attrs.orvilo to
-- content.attrs.mikka. Run AFTER the Mikka code is deployed: it reads both
-- keys, but the previous deployment only reads `orvilo`.
-- Applied by scripts/migrate.mjs on production builds.

update issues
set content = jsonb_set(content, '{attrs}', ((content->'attrs') - 'orvilo') || jsonb_build_object('mikka', content->'attrs'->'orvilo'))
where (content->'attrs') ? 'orvilo' and not ((content->'attrs') ? 'mikka');
