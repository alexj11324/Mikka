# Mikka mobile

The iOS app (Expo SDK 58, Expo Router). Spec: `docs/design/mobile.md`; frames:
Figma page `268:4750`.

The screens read the server's `app/api/mobile/*` routes (mobile.md,
"Engineering"). `EXPO_PUBLIC_API_URL` points the app at a preview deployment,
with the base path (e.g. `https://<preview>/mikka`); the default is production.

```sh
pnpm install                       # from the repository root
pnpm --filter @mikka/mobile web    # Expo web, for screenshot checks
pnpm --filter @mikka/mobile typecheck
```

Per `AGENTS.md`, do not run the dev server or simulator on the developer's
Mac; check screens with Expo web in a cloud session, and build iOS on EAS.

Layout:

- `app/`: routes. `index` is the Coordinator chat; `suggestions`, `threads`,
  `tasks`, `bots/[id]` sit behind the drawer; `threads/[id]` is a pushed
  page; `settings/` is a modal stack.
- `components/`: the drawer, chat pieces (bubbles, mention chips, proactive
  and thread cards, swipe-for-times), the composer, settings rows, icons.
- `lib/`: the auth client, `api()` and `useApi()`, response types, push
  registration, theme colours.

## Push

Registering a phone for pushes needs the EAS project id. `app.config.ts`
reads it from `EAS_PROJECT_ID` into `extra.eas.projectId`; set it as an EAS
environment variable (`eas env:create --name EAS_PROJECT_ID ...`) or in the
shell for a local build. `eas init` prints the id. Without it the app runs but
cannot register, and Settings shows 「推送无法送达」. The server sends through
Expo's push service (`lib/mobile-push.ts`, optional `EXPO_ACCESS_TOKEN`).

The app asks iOS for permission after the Coordinator's first message of its
own, or when the person turns a push on in 通知; never at launch. A tapped
push opens what it is about (`lib/push-route.ts`): a proposal's card
(`pendingActionId`), a finished thread (`runId`), or the chat it came from
(`botId`).
