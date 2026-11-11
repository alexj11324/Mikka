# Telegram integration

The Telegram bot accepts private messages only. Users connect it from **Settings → Connections** with a one-time link. Ordinary messages go to the user's persistent Coordinator chat and its replies return to Telegram. While a `/new` draft is active, ordinary messages add draft details.

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

## Native reply delivery

Eve owns the Coordinator's turns, queue and committed replies. Telegram's
existing Chat SDK handler records the linked person's message in the personal
Coordinator chat, so Telegram and the web retain the same conversation.
Pairing, private-message verification and commands use the existing handler.

The pinned Eve Chat SDK channel selects its session from the supplied thread.
Using that channel here would create a separate conversation from the web's
personal Coordinator. The product outcome adapter instead delivers the
committed native root reply to the existing linked Telegram conversation.
It checks the exact stored source event, current link, conversation owner,
personal Coordinator, workspace membership and linked task before posting.

`lib/eve/outcome-delivery.ts` reads the committed product projection and stores
an `eve_outcome_deliveries` receipt before each Telegram chunk. A repeated
finish call skips completed chunks. A dispatch interrupted before its result
is stored, or a post with an unknown result, is not posted again automatically.
The receipt stores a digest, not another copy of the reply. A `no_reply` call
suppresses outbound delivery even when the turn contains earlier partial text;
quiet replies, cancelled turns and scheduled reads also send nothing here.

The same adapter calls the existing phone push Decision service once for each
eligible outcome. Its notification settings, muted chats, phone-session access
and task routing still apply. Verification codes are withheld from the push
judge's text and the lock screen, and are not posted to Telegram. Actionable
model refusals use the existing translated refusal line; raw provider errors
are not posted.

To verify delivery against your isolated local test database, run:

```sh
REQUIRE_DB=1 node --experimental-test-module-mocks --import ./scripts/server-test.mjs --import tsx --test lib/eve/outcome-delivery.db.test.ts
```

The test folds public Eve events into a committed outcome, uses real PostgreSQL
receipts and authorization rows, and substitutes only Telegram transport and
external push/Decision calls. It sends no real Telegram message or paid prompt.
