# Mikka mobile

The iOS app (Expo SDK 58, Expo Router). Spec: `docs/design/mobile.md`; frames:
Figma page `268:4750`.

The screens run on sample data in `lib/mock.ts` until the mobile API exists
(mobile.md, "Engineering prerequisites"). Sign-in, push and the chat stream
are not wired yet.

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
- `lib/`: theme colours and sample data.
