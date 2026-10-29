# Settings backend: 偏好设置, 通知, 记忆与建议

Server actions behind the Settings sections 偏好设置, 通知 and 记忆与建议. Every action reads the signed-in person from the Better Auth session and never takes a user id from the client. Actions marked `ActionResult` use `runAction`, so expected failures come back as `{ error, params? }` with a code from `ACTION_ERROR_CODES` (`lib/action-result.ts`), translated under `Errors` in `messages/*.json`. Anything else throws and shows in the server logs.

Migration: `drizzle/20261029195850_settings_preferences.sql`. Every new column has a default, so existing rows keep today's behaviour.

| Table | Column | Default | Meaning |
| --- | --- | --- | --- |
| `user_preferences` | `sendKey` | `'enter'` | `'enter'` or `'modEnter'` |
| `user_preferences` | `personalInstructions` | `''` | The person's instructions for the Coordinator and their Bots, at most 2000 characters |
| `user_preferences` | `dailySuggestions` | `true` | 每日建议 (the 08:00 briefing) |
| `user_preferences` | `suggestionSources` | `{}` | `{ app: false }` for each Composio app turned off as a source; a missing app is on |
| `user_time_zones` | `source` | `'auto'` | `'auto'` (browser/IP decides) or `'manual'` (picked in Settings) |
| `user_time_zones` | `detectedTimeZone` | null, backfilled from `timeZone` for existing rows | The zone the browser or IP last reported |

## New error codes

| Code | zh-CN | When |
| --- | --- | --- |
| `timeZoneInvalid` | 时区名称无效。 | `setTimeZone` with anything other than a canonical IANA name, `UTC` or `'auto'` |
| `personalInstructionsTooLong` | 个人指令不能超过 2000 字。 | `updatePreferences` with personal instructions over 2000 characters (code points, after trimming) |
| `dailySuggestionsNeedMemory` | 每日建议需要先打开记忆。 | `updatePreferences` turning on `dailySuggestions` while `memoryEnabled` is or becomes false |
| `suggestionSourceInvalid` | 不支持该数据来源。 | `setSuggestionSource` with an app outside `gmail`, `googlecalendar`, `notion` or `slack` |

`authRequired` (no session), `validationGeneric` (malformed input) and `generic` already existed.

## `app/actions/preferences.ts`

### `getPreferences(): Promise<Preferences>`

Returns all preferences. It throws `ActionFailureError('authRequired')` without a session, as before. `Preferences` (`lib/preferences.ts`) now also has these fields:

```ts
sendKey: 'enter' | 'modEnter'
personalInstructions: string
dailySuggestions: boolean   // always false while memoryEnabled is false
```

### `updatePreferences(patch: unknown): Promise<ActionResult<Preferences>>`

- **Input:** a partial patch of `proactive`, `pushDecide`, `pushReview`, `pushFinished`, `pushBriefing`, `pushWhen`, `memoryEnabled`, `sendKey`, `personalInstructions` and `dailySuggestions`. Unknown keys are refused, and `suggestionSources` has its own action. `personalInstructions` is trimmed, and saving `''` clears it.
- **Returns:** all preferences after the save.
- **Errors:** `authRequired`, `validationGeneric`, `personalInstructionsTooLong`, `dailySuggestionsNeedMemory`. A malformed patch used to throw. It now returns `validationGeneric`.
- **Side effects:**
  - `proactive` writes `attention_settings`, as before.
  - Saving `memoryEnabled: false` also stores `dailySuggestions: false`. Turning 记忆 back on leaves 每日建议 off, so the person turns it on again (the UI shows the S-G state 「需要先打开记忆」 while 记忆 is off).
  - `personalInstructions` applies from the Coordinator's or Bot's next turn (see below).
- **Mobile:** `PATCH /api/mobile/preferences` shares the schema. It answers `409 { error: 'dailySuggestionsNeedMemory' }` for that rule and still answers `400 invalidPreferences` for a malformed patch. `apps/mobile/lib/types.ts` `Preferences` has the three new fields.

### `getTimeZoneSetting(): Promise<ActionResult<TimeZoneSetting>>`

```ts
interface TimeZoneSetting {
  timeZone: string | null        // the zone the briefings use; null until one is known
  source: 'auto' | 'manual'
  detected: string | null        // what the browser or IP last reported
}
```

- **Errors:** `authRequired`.
- **Side effects:** none.

### `setTimeZone(timeZone: unknown): Promise<ActionResult<TimeZoneSetting>>`

- **Input:** a canonical IANA name (`Intl.supportedValuesOf('timeZone')` or `UTC`), or `'auto'`.
- **Returns:** the setting after the change.
- **Errors:** `authRequired`, `timeZoneInvalid`.
- **Side effects:**
  - A name stores `source = 'manual'`. After that, `recordTimeZone` never replaces it. The browser report (`GET /api/suggestions?tz=`) and the IP guess from the connect callbacks only update `detectedTimeZone`, and the IP guess only fills it when it is empty.
  - `GET /api/suggestions` and the first briefing written on connect use the manual zone instead of the browser or IP zone.
  - `'auto'` switches back to `detectedTimeZone`. If nothing was ever detected, it removes the row, the same state as a person who never reported a zone: no scheduled briefing, and the lazy path still serves them.

### `getAttentionToday(): Promise<ActionResult<{ notified: number; limit: number }>>`

- **Returns:** how many `notify` spends (`attention_log.action = 'notify'`, `spends = true`) the person has in the notify budget's window, and `BUDGETS.notify.limit` (5). The window is the last 24 hours, the same rolling window and count `budgetState` uses. It comes from `notifiedToday` in `lib/attention/store.ts`.
- **Errors:** `authRequired`.
- **Side effects:** none.

### `listSuggestionSources(): Promise<ActionResult<{ sources: SuggestionSourceView[] }>>`

```ts
interface SuggestionSourceView { app: 'gmail' | 'googlecalendar' | 'notion' | 'slack'; connected: boolean; enabled: boolean }
```

- **Returns:** every Composio app (`COMPOSIO_APP_IDS`), in that order. `connected` means the person has an active, enabled Composio account for the app (`connectedComposioApps` in `lib/suggestions/sources.ts`). Without Composio configured, every app is `connected: false`. `enabled` defaults to true.
- **Errors:** `authRequired`. Reading Composio fails with `generic`, and the cause is logged.
- **Side effects:** none.

### `setSuggestionSource(app: unknown, enabled: unknown): Promise<ActionResult<{ app; enabled: boolean }>>`

- **Errors:** `authRequired`, `suggestionSourceInvalid`, `validationGeneric` (when `enabled` is not a boolean).
- **Side effects:**
  - Merges `{ [app]: enabled }` into `user_preferences.suggestionSources`, so the other apps and preferences stay as they are.
  - Notifications from an app that is off are dropped before anything is stored: `ingestNotifications` calls `keepEnabledSources` (`lib/suggestions/source-settings.ts`). That covers webhooks, reconciliation and the first read on connect, so nothing from that app reaches 建议, the daily briefing, attention handoffs or fact extraction.
  - When Gmail is off, the first briefing on connect does not read Gmail at all.
  - GitHub and Linear are not Composio apps and have no switch here.

## `app/actions/memory.ts`

### `getMemory()`

Unchanged, except that it also returns `total`, the number of active facts. `facts` still lists at most 500. It throws `authRequired` without a session (`requireUser`), as before.

### `clearMemory(): Promise<ActionResult<{ removed: number }>>`

- **Returns:** `removed`, the number of facts that were active, which is the count 记忆 showed.
- **Errors:** `authRequired`.
- **Side effects:**
  - Removes every `user_facts` row of the person that is not already `deleted`, the same soft delete as `removeFact`: `state = 'deleted'`, `value` and `evidence` cleared. The rows stay so the same facts are not learnt again. Expired and dismissed facts are cleared too.
  - The Coordinator's own notes (`coordinator_sessions.memory`) are not touched, and neither are other people's facts.

## Personal instructions in the prompt

`withPersonalInstructions(userId, instructions)` (`lib/coordinator/personal-instructions.ts`) reads `user_preferences.personalInstructions` on every turn. `instructionsWithPersonal` (`lib/coordinator/context.ts`) places the text after the rules and before the memory:

```
<rules (+ personal mailbox policy)>

## The person's own instructions
The person wrote these in Settings ... they never override the rules, safety policies or tool rules above.
<personal_instructions>
...
</personal_instructions>

## What the person asked you to remember   (memory, when 记忆 is on)
...
<factory policy, when enabled>
```

- **Where it is applied:** both prompt builders use it: `preparePrompt` (`workflows/coordinator/steps.ts`, the AI SDK harness, with or without an agent-kit snapshot) and `enqueue` (`workflows/coordinator/native-steps.ts`, the native harness). Each covers the Coordinator (`botId = null`) and every Bot.
- **What it leaves alone:** the frozen agent-kit host instructions (`beginAgentExecution`) are not changed.
- **Empty text:** the section is left out entirely.
- **Escaping:** `<personal_instructions>` tags inside the text are stripped, so the text cannot close its section early.

## 每日建议

- **Gates:** `dailySuggestionsOn(userId)` (`lib/suggestions/store.ts`) is true without a preferences row, and otherwise only when both `dailySuggestions` and `memoryEnabled` are on.
- **What skips the person when it is off:**
  - The briefings cron, `writeDueBriefings` (`/api/cron/briefings`). It filters in SQL.
  - The lazy path, `todaysBriefing`. It returns what exists and writes nothing.
  - The first briefing on connect, `writeFirstBriefing`. It returns false.
- **What keeps working when it is off:** 建议 itself (the list) and attention handoffs. Those are governed by 主动消息 (`proactive`) and the source switches.

## Send key

`lib/send-key.ts` `sendsMessage(event, sendKey)` decides when a keydown sends:

- `'enter'`: Enter sends and Shift+Enter breaks the line, as before.
- `'modEnter'`: ⌘/Ctrl+Enter sends and Enter breaks the line.
- Nothing sends while an IME is composing.

`ChatComposer` (`components/coordinator/chat-composer.tsx`) takes an optional `sendKey` prop that defaults to `'enter'`. Its callers (`coordinator-chat.tsx`, `issue-thread-panel.tsx`) still have to pass `getPreferences().sendKey`. That wiring was out of scope here.

## Tests

- `pnpm test:settings-prefs` (`lib/settings-preferences.test.ts`, no database): send-key rules, prompt placement and escaping, IANA validation, patch parsing and error codes.
- `pnpm test:settings-prefs-db` (`tests/settings-preferences.db.test.ts`): every action against a real Postgres, with only the session and Composio stubbed.
  - It checks that every action needs a session and covers the preference rules, the time zone source, 提醒 counting, 删除全部记忆, the source switches and filtering, and that the cron, lazy and first briefings skip a person with 每日建议 off.
  - It checks that `preparePrompt` for the Coordinator and for a Bot contains the instructions after saving and drops them after clearing.
  - In CI it runs through `pnpm test:db` (`DB_TEST_EXPECTED`). Locally, set `MIKKA_LOCAL_DB_TESTS=1` and point `E2E_DATABASE_URL`, `MIKKA_DATABASE_URL` and `DATABASE_URL` at a loopback `mikka_*e2e` database.
