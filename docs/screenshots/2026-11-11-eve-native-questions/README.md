# Native Eve freeform question UI

Captured from the complete official local Node production build `379c17a8b8936f24109b2be07fed04d3ed0c4986`, with UI overlay `0a6e897`, Chromium 154.0.8037.57 and an owned disposable PostgreSQL 17 environment. The browser used an ordinary leased test-account cookie; email stayed in a local SMTP sink. The application version endpoint matched the captured build.

These are **renderer fixtures**, not model execution, successful live answers or production deployment evidence. The browser supplied the public native empty-create response and the [v27 event stream](ask-question-v27.ndjson). The stream contains `call.requested` for `ask_question`, `interaction.opened` with `allowFreeform: true`, and `turn.paused`. The actual public Client stream parser and `openInteractions` projection validated it before capture. No private SDK store or component state was injected.

## Images

| Surface | Evidence |
| --- | --- |
| Official Web, light, 1440 × 1000 | [Freeform answer](web-native-question-light-1440.png) |
| Official Web, dark, 1440 × 1000 | [Freeform answer](web-native-question-dark-1440.png) |
| Official Web, light, 390 × 844 | [Narrow answer control](web-native-question-light-390.png) |
| Expo Web, light, 390 × 844 | [Native question card and composer](expo-native-question-light-390.png) |
| Expo Web, dark, 390 × 844 | [Native question card and composer](expo-native-question-dark-390.png) |

## Fixture and build boundaries

The Expo production export used the same source revision and `.hosted-ui/mobile` overlay, with pinned pnpm 10.34.3 and `expo export --platform web --max-workers 2`. It was served on an isolated local port. Browser routing delivered only those unchanged document/assets at the canonical application origin, so the real session and workspace reads used their normal cookies; no Origin header was rewritten and server CSRF rules were unchanged.

The leased account had no model service configured. For the Expo paused-question scenario, its readonly chat response also supplied `enabled: true` and the user message matching the fixture's `delivery.consumed`. These were browser-only UI fixtures: server configuration and conversation history were not changed. Every native answer/model command was blocked, and no answer button was pressed. Separate API/CLI acceptance covers real protocol authorization and delivery.

## Review

The Web control uses the existing `Item`, `FieldGroup`, horizontal `Field`, `Input` and `Button`; the mobile screen uses its existing `ChatCard` and composer. No paid block was restyled. The owning agent reviewed all five images against the repository UI checklist: question, answer and action remain visible without clipping or horizontal overflow; dark controls have no white hairlines; no framework overlay or JavaScript exception appeared.

On Web, the empty answer disables submit; typing enables it, and Tab reaches submit next. On Expo Web, the empty paused-turn composer shows Stop; typing the answer exposes an enabled Send action. Neither action was submitted. The existing Web avatar asset `/avatars/purple.webp` returned 404; Expo captures had no HTTP errors. [Capture metadata](capture.json) records the viewports and boundaries.

## TestFlight checks still required

- Open an existing pending question on iPhone. Check keyboard and safe-area spacing, long Chinese input, and the question card in light and dark appearance.
- Submit one answer in the correct Bot. Verify the pending control prevents duplicate answers, the question closes after the native response event, and reconnecting does not restore it.
- Switch Bot, Workspace and account while a question is open. Verify no previous question or draft leaks into the next identity, and native requests pass the cookie/Origin boundary without 401/403. Inspect status codes only, never credential values.

Expo Web does not verify UIKit keyboard behavior, keychain storage or native request headers. The [earlier MCP settings evidence](../2026-11-11-eve-native-mcp/README.md) remains bound to its own build and unchanged settings source.
