# Personal message submission and retries

Send personal chat messages through the authenticated Eve session endpoint. You can submit to the workspace’s Coordinator or to a Bot that belongs to the same workspace and owner.

## Send a message

Send `POST /api/agents/eve/v1/session?botId=BOT_ID` under the application base path. Pass the message in `{"message":"Hello"}` and a UUID in the `x-mikka-submission-id` header. Omit `botId` to select the Coordinator in the authenticated workspace. You can use native message parts for text and images and the existing Eve `clientContext` for quotes, notes, and task choices. An expected owner or workspace can reject a stale selection. Authentication supplies the owner and workspace.

Eve returns HTTP 202 with the admitted delivery and session IDs. That response acknowledges the send. Read the session stream for the reply or the turn’s failure.

The old `POST /api/coordinator/messages` and `POST /api/mobile/chat` routes return HTTP 410. The `coordinator.sendCoordinatorMessage` RPC action is no longer registered. The existing chat read APIs continue to serve history.

## Retry a send

1. Allocate one UUID for each new message and freeze its Bot, content, and context. Keep a pending record without credentials.
2. After a timeout, lost response, or server failure, retry with the same UUID, body, and Bot from the same account. A new message gets a new UUID even if its content is identical.
3. After an authentication failure, sign back into the same account before retrying. An authorization, validation, or payload conflict requires user action before another send.
4. Clear the pending record after Eve acknowledges the send.

The receiver checks body and image limits and resolves the Bot against the authenticated workspace. The durable key binds the owner, resolved Bot, and normalized UUID. Identical retries reuse the existing event. A retry with changed text, images, or task context cannot overwrite the stored event. Pending events remain available to the existing Eve delivery and recovery flow.
