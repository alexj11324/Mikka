-- target: MIKKA_DATABASE_URL
-- Sharing a Chat exposes new, explicitly submitted collaboration messages,
-- not the original Owner's private transcript or its stored file identifiers.
-- This is only the disclosure gate: every caller also checks current resource
-- ACL, Workspace/Enterprise membership, and execution authority when relevant.
CREATE FUNCTION mikka_chat_attachment_visible(file_id uuid,viewer_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM chat_attachments f WHERE f.id=file_id
    AND f."workspaceId" IS NOT NULL AND (f."userId"=viewer_id OR (f."usedAt" IS NOT NULL AND (
      f."resourceKind"<>'chat' OR f."scopeOwnerId"=viewer_id OR EXISTS(
        SELECT 1 FROM coordinator_events e JOIN bot_chat_submission_authorities a ON a."eventId"=e.id
        WHERE e.kind='user_message' AND e."userId"=f."scopeOwnerId" AND e."botId"=f."botId"
          AND a."ownerId"=f."scopeOwnerId" AND a."botId"=f."botId" AND a."workspaceId"=f."workspaceId"
          AND a."contextIsolation"='shared_clean' AND e."createdAt">=f."usedAt"
          AND f."resourceId"=mikka_chat_resource_id(a."ownerId",a."botId")
          AND position('[mikka-file:'||f.id::text||':' in e.payload->>'text')>0
          AND mikka_bot_chat_event_visible(a."ownerId",a."botId",e.id)
      )
    ))));
$$;
