# Slack bot

Slack uses eve's native Slack Channel and Agent session. It accepts explicit `@Mikka` mentions, direct messages and relevant messages in member-selected ambient channels. Replies stay in the originating thread. Each Mikka owner and workspace has its own eve continuation address, including when several bound people use the same Slack thread. The old standalone Slack model loop is retired.

The Composio Slack connection is separate: it supplies user-authorized integration tools. A Slack bot needs its own installed bot token and Signing Secret. App configuration access/refresh tokens are operator credentials and must not be used as bot credentials.

## Workspace installation

Open **Plugins → Slack → Slack bot**, select a Mikka workspace and choose **Connect Slack**. Both the browser and the Mikka app must use the same Mikka account. Slack authenticates the installer and their Slack team. Each additional member links their own Slack account in that workspace. No one enters a token, channel ID or user ID. The Slack toolkit settings on the same page manage Composio tools independently.

The business API holds the platform `SLACK_APP_ID`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and the existing Workspace Secrets encryption key. Configure the exact HTTPS callback `https://<deployment-host>/mikka/api/integrations/slack/callback` in Slack. Eve verifies incoming events with the platform `SLACK_SIGNING_SECRET` and app ID. OAuth grants, revocation state and member preferences live in PostgreSQL. The official channel obtains a bot grant from the business service for a verified installation, team, sender and current Workspace member. The shared Eve environment contains no workspace token or sender map.

A member can enable or pause delivery, select ambient channels by name, or unlink their own account. The installer or an active Mikka workspace administrator can uninstall the bot for the whole team. Revocation immediately disables delivery while Slack completes uninstall. If Slack is unavailable, retry uninstall on the same page. Signed app removal and bot-token revocation events remove the affected installation. A signed Slack member deactivation unlinks that member while retaining other members.

Eve owns the durable session, queue, stop/steering, tool approvals and Slack rendering. Mikka adds the verified Slack event id as the eve delivery's idempotency key and namespaces continuation addresses by Mikka owner/workspace. Eve also rejects duplicate provider events within the serving process. No separate Redis or Chat SDK state service is required for this channel.

The ambient pipeline asks one `eve/ai` decision question before admitting a message. Its model adapter retains Mikka's existing Decision model, credential, admission, billing and telemetry boundary. An irrelevant message or unavailable decision creates no Agent delivery and posts no reply or working status. Admitted ambient turns remain quiet until useful work begins and can end through eve's `no_reply` tool.

## Slack app settings and acceptance

1. Add the OAuth scopes requested by the installation flow: `app_mentions:read`, `chat:write`, `users:read`, `channels:read`, `channels:history`, `groups:read`, `groups:history`, `im:read` and `im:history`. Reinstall after a scope change.
2. In Event Subscriptions, enable events and use `https://<deployment-host>/mikka/api/webhooks/slack`. Slack must be able to reach this URL at its stable deployment origin. The signed verification challenge works before the first installation.
3. Subscribe to `app_mention`, `message.channels`, `message.groups` `message.im`, `app_uninstalled`, `tokens_revoked` and `user_change` for the configured surfaces and revocation events. Set Interactivity's Request URL to the same webhook so eve's approval/question controls work. Socket Mode must be disabled for HTTP events. The app webhook forwards the signed bytes to eve's `/eve/v1/slack` route.
4. Invite Mikka into a test channel, then send `@Mikka list my agents and their devices`. Confirm a same-thread response with only the bound user's devices. Next, explicitly request a run for an existing issue and agent; confirm its run id in Mikka. An offline device may keep the run queued until it connects.
5. Replay the same signed event to check that it does not dispatch twice; tampered, missing, or stale signatures must return 401. A signed URL-verification challenge returns 200 without calling the model or connecting to the database. Valid events for other workspaces/apps/unbound users return 204 without invoking tools.
6. In a watched channel, post an actionable question without a mention and verify its same-thread reply. Post ordinary social chat and verify that no reply or working status appears. Repeat outside the watched selection and verify that it creates no decision request. Verify that another bound owner in the same Slack thread has a separate session and cannot answer the first owner's approval.

Long processing runs in eve's durable session after Slack's acknowledgement. The handler imports only authorized context from this Slack thread, since the last Agent reply; it never imports private Mikka chat history or personal memory. A delivered source-request row supplies the existing Factory tools with original-human-request provenance, without waking a second web turn or mirroring the Slack conversation into the web transcript. Task completion remains in Mikka; this channel does not promise unsolicited Slack completion messages.

Run `pnpm test:slack-installation-db` against a migrated test PostgreSQL instance for grant, membership, isolation and revocation tests. Run `pnpm test:slack` for signed request admission, native channel delivery, ambient silent skips, billing-boundary adaptation, owner-separated session addresses and provider-event deduplication. Live Slack/provider acceptance remains a separate production check.
