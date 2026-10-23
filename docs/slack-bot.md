# Slack bot

This first version handles explicit `@Mikka` mentions in one installed Slack workspace. It runs the existing Coordinator tools as the bound Mikka user, so it can list devices/agents, inspect issues, dispatch runs, send instructions, and check or stop runs. Each mention is a separate request, with its response in the same Slack thread. Include the issue/run id when following up. Run completion remains in Mikka; there are no unsolicited Slack completion messages yet.

The Composio Slack connection is separate: it supplies user-authorized integration tools. A Slack bot needs its own installed bot token and Signing Secret. App configuration access/refresh tokens are operator credentials and must not be used as bot credentials.

## Cloud configuration

Keep `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` in Infisical and deliver them through the deployment's native cloud Secret Sync. Set `SLACK_APP_ID`, `SLACK_TEAM_ID`, `SLACK_BOT_USER_ID`, and `SLACK_USER_BINDINGS` for that same installation. The binding is a JSON object mapping verified Slack member ids to existing Mikka user ids. Establish the binding from the member's authenticated Slack connection, not their display name or a message claiming an email address. Unbound senders are ignored.

Apply `drizzle/0018_slack_chat_state.sql` to the deployment's matching Mikka database, including its isolated Preview database. Runtime DDL is disabled. No new Redis service is required. The Chat SDK's Postgres state supplies message deduplication and locks across serverless instances.

## Slack app settings and acceptance

1. Install the app with `app_mentions:read` and `chat:write`. The adapter also uses `users:read` to resolve authors. Reinstall after scope changes.
2. In Event Subscriptions, enable events and use `https://<deployment-host>/mikka/api/webhooks/slack`. Slack must be able to reach this URL without an interactive Vercel login. Use the frozen deployment URL for Preview acceptance and the stable production origin only after promotion.
3. Subscribe to the bot event `app_mention` and save. Socket Mode must be disabled for HTTP events.
4. Invite Mikka into a test channel, then send `@Mikka list my agents and their devices`. Confirm a same-thread response with only the bound user's devices. Next, explicitly request a run for an existing issue and agent; confirm its run id in Mikka. An offline device may keep the run queued until it connects.
5. Replay the same signed event to check that it does not dispatch twice; tampered, missing, or stale signatures must return 401. A signed URL-verification challenge returns 200 without calling the model or connecting to the database. Valid events for other workspaces/apps/unbound users return 204 without invoking tools.

Long processing starts a durable Workflow after Slack's HTTP acknowledgement. The handler does not load or publish private Coordinator conversation history, memory, or other users' channel messages. It does not subscribe to ordinary channel chatter.
