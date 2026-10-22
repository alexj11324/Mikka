# Telegram integration

The Telegram bot accepts private messages only. Users connect it from **Settings → Integrations** with a one-time link, then create Backlog issues and link the chat to existing issues.

## Production configuration

The `mikka` Vercel project's Production environment needs these variables:

- `TELEGRAM_BOT_TOKEN`: the token issued by BotFather.
- `TELEGRAM_BOT_USERNAME`: the bot username without `@`.
- `TELEGRAM_WEBHOOK_SECRET_TOKEN`: a random value using only letters, numbers, `_`, or `-`.

Keep the token and webhook secret in Vercel's encrypted Production environment variables. They do not belong in the repository. Production builds run `scripts/migrate.mjs`, which applies the Telegram schema from `drizzle/0004_telegram_chat.sql` to the application database.

After the production deployment is ready, register `https://app.aspectlylabs.com/api/webhooks/telegram` with Telegram's `setWebhook` method. Set its `secret_token` to the same value as `TELEGRAM_WEBHOOK_SECRET_TOKEN`. The bot uses webhook delivery; do not run `getUpdates` for the same bot while the webhook is configured.

## Commands

- `/start <pairing token>` completes the one-time connection from Settings.
- `/new <title>` starts an issue draft. Send detail messages, then use `/confirm` to create a Backlog issue.
- `/cancel` discards the current draft.
- `/issues` lists recent accessible issues.
- `/link ORV-123` or `/link <issue UUID>` links the chat to an issue.
- `/status` shows the linked issue; `/unlink` clears that link.
- `/help` lists the commands.
