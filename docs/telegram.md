# Telegram integration

The Telegram bot accepts private messages only. Users connect it from **Settings → Connections** with a one-time link. Ordinary messages go to the Coordinator chat of the person's selected Mikka workspace and its replies return to Telegram. Today the link names a person and no workspace, so they reach the personal workspace's Coordinator; choosing the workspace from Telegram, and asking a person with none to choose, are target contract. While a `/new` draft is active, ordinary messages add draft details.

## Production configuration

The `mikka` Vercel project's Production environment needs these variables:

- `TELEGRAM_BOT_TOKEN`: the token issued by BotFather.
- `TELEGRAM_BOT_USERNAME`: the bot username without `@`.
- `TELEGRAM_WEBHOOK_SECRET_TOKEN`: a random value using only letters, numbers, `_`, or `-`.

Store the token and webhook secret in the Mikka Infisical Cloud project and
deliver them through the deployment's existing Secret Sync. The Telegram schema
is `drizzle/0004_telegram_chat.sql`. See
[migration bootstrap](migration-bootstrap.md) for when migrations run.

After the production deployment is ready, register `https://app.aspectlylabs.com/mikka/api/webhooks/telegram` with Telegram's `setWebhook` method. Set its `secret_token` to the same value as `TELEGRAM_WEBHOOK_SECRET_TOKEN`. The bot uses webhook delivery; do not run `getUpdates` for the same bot while the webhook is configured.

## Commands

- Send an ordinary message to talk with the Coordinator.
- `/start <pairing token>` completes the one-time connection from Settings.
- `/new <title>` starts an issue draft. Send detail messages, then use `/confirm` to create a Backlog issue.
- `/cancel` discards the current draft.
- `/issues` lists recent accessible issues.
- `/link MIK-12` or `/link <issue UUID>` links the chat to an issue.
- `/status` shows the linked issue; `/unlink` clears that link.
- `/help` lists the commands.
