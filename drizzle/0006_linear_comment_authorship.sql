-- Keep the authenticated app writer bound to its Linear comment across Yjs undo/recreate cycles.

alter table linear_comment_links add column if not exists "authorUserId" text;
