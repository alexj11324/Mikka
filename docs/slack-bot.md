# Slack bot

Slack uses eve's native Slack Channel and Agent session. It accepts explicit `@Mikka` mentions, direct messages and relevant messages in operator-selected ambient channels. Replies stay in the originating thread. Each Mikka owner and workspace has its own eve continuation address, including when several bound people use the same Slack thread. The old standalone Slack model loop is retired.

The Composio Slack connection is separate: it supplies user-authorized integration tools. A Slack bot needs its own installed bot token and Signing Secret. App configuration access/refresh tokens are operator credentials and must not be used as bot credentials.

## Cloud configuration

Keep `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` in Infisical and deliver them to the eve service through the deployment's native cloud Secret Sync. Set `SLACK_APP_ID`, `SLACK_TEAM_ID`, `SLACK_BOT_USER_ID`, and `SLACK_USER_BINDINGS` for that installation. The binding is a JSON object mapping verified Slack member ids to existing Mikka user ids. Establish the binding from the member's authenticated Slack connection, not their display name or a message claiming an email address. Unbound senders and messages from other apps/workspaces are ignored before any Slack acknowledgement or model call.

`SLACK_WATCHED_CHANNELS` is a JSON array of Slack channel ids selected for ambient listening, such as `["C0123456789"]`. Mentions and DMs do not need an ambient selection. An ordinary message outside the selection does not reach a decision model or Agent. Malformed routing configuration disables the channel instead of widening its access.

`SLACK_CHANNEL_WORKSPACES` optionally maps channel ids to Mikka workspace UUIDs. An unmapped channel uses the bound person's personal workspace, preserving the previous binding behavior. A selected workspace must still authorize that owner; the Agent rechecks the Bot/workspace boundary when resolving tools. Never use message text to choose a workspace.

Eve owns the durable session, queue, stop/steering, tool approvals and Slack rendering. Mikka adds the verified Slack event id as the eve delivery's idempotency key and namespaces continuation addresses by Mikka owner/workspace. Eve also rejects duplicate provider events within the serving process. No separate Redis or Chat SDK state service is required for this channel.

The ambient pipeline asks one `eve/ai` decision question before admitting a message. Its model adapter retains Mikka's existing Decision model, credential, admission, billing and telemetry boundary. An irrelevant message or unavailable decision creates no Agent delivery and posts no reply or working status. Admitted ambient turns remain quiet until useful work begins and can end through eve's `no_reply` tool.

## Slack app settings and acceptance

1. Install the app with `app_mentions:read`, `chat:write` and `users:read`. Ambient public channels need `channels:history`; private channels need `groups:history`; DMs need `im:history`. Reinstall after scope changes.
2. In Event Subscriptions, enable events and use `https://<deployment-host>/mikka/api/webhooks/slack`. Slack must be able to reach this URL without an interactive Vercel login. Branches have no Vercel Preview; use the stable production origin after merge.
3. Subscribe to `app_mention`, `message.channels`, `message.groups` and `message.im` for the surfaces you configured. Set Interactivity's Request URL to the same webhook so eve's approval/question controls work. Socket Mode must be disabled for HTTP events. The app webhook forwards the signed bytes to eve's `/eve/v1/slack` route.
4. Invite Mikka into a test channel, then send `@Mikka list my agents and their devices`. Confirm a same-thread response with only the bound user's devices. Next, explicitly request a run for an existing issue and agent; confirm its run id in Mikka. An offline device may keep the run queued until it connects.
5. Replay the same signed event to check that it does not dispatch twice; tampered, missing, or stale signatures must return 401. A signed URL-verification challenge returns 200 without calling the model or connecting to the database. Valid events for other workspaces/apps/unbound users return 204 without invoking tools.
6. In a watched channel, post an actionable question without a mention and verify its same-thread reply. Post ordinary social chat and verify that no reply or working status appears. Repeat outside the watched selection and verify that it creates no decision request. Verify that another bound owner in the same Slack thread has a separate session and cannot answer the first owner's approval.

Long processing runs in eve's durable session after Slack's acknowledgement. The handler imports only authorized context from this Slack thread, since the last Agent reply; it never imports private Mikka chat history or personal memory. A delivered source-request row supplies the existing Factory tools with original-human-request provenance, without waking a second web turn or mirroring the Slack conversation into the web transcript. Task completion remains in Mikka; this channel does not promise unsolicited Slack completion messages.

Run `pnpm test:slack` for signed request admission, native channel delivery, ambient silent skips, billing-boundary adaptation, owner-separated session addresses and provider-event deduplication. Live Slack/provider acceptance remains a separate production check.
