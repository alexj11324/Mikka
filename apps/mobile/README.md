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
