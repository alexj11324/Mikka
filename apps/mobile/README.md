# Mikka mobile

The iOS app (Expo SDK 58, Expo Router). Spec: `docs/design/mobile.md`.
The design authority is the current main implementation and accepted decisions
in `docs/design/README.md`. Figma page `268:4750` is archived (#1296);
`358:9186` is a reference to verify, not an accepted redesign spec.

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
For #1296, use Docker Cloud Sandbox Large (8 vCPU / 16 GiB) first;
Vercel Sandbox is a fallback only when Docker is unavailable. Stop the sandbox
after the work. Expo web checks do not verify UIKit navigation, haptics,
VoiceOver, Dynamic Type or native Reduce Motion on an iPhone.

Layout:

- `app/`: routes. `(tabs)/chats` is the opening chat list, with `threads`
  and `search` beside it. Bot and group chats and `thread/[id]` are pushed
  pages; the drawer opens `suggestions`, `tasks`, `plugins` and `settings/`,
  which is a modal stack.
- `components/`: the drawer, chat pieces (bubbles, mention chips, proactive
  and thread cards, swipe-for-times), the composer, settings rows, icons.
- `lib/`: the auth client, `api()` and `useApi()`, response types, push
  registration, theme colours.

## Push

Registering a phone for pushes needs the EAS project id, committed in
`app.json` (`extra.eas.projectId`); `EAS_PROJECT_ID` overrides it for a fork's
own EAS project (`app.config.ts`). Without it the app runs but cannot
register, and Settings shows 「推送无法送达」. The server sends through
Expo's push service (`lib/mobile-push.ts`, optional `EXPO_ACCESS_TOKEN`).

The app asks iOS for permission after the Coordinator's first message of its
own, or when the person turns a push on in 通知; never at launch. A tapped
push opens what it is about (`lib/push-route.ts`): a proposal's card
(`pendingActionId`), a finished thread (`runId`), or the chat it came from
(`botId`).

## Releases

Web/API deployment, an EAS Update, and an installed iOS binary are separate
release results. Record each result against its own source commit.

### JavaScript updates

`.github/workflows/mobile-update.yml` publishes iOS JavaScript updates:
main goes to the `production` channel, a pull request to branch `pr-<n>`.
Check that the publish step actually ran: without `EXPO_TOKEN`, this workflow
reports a notice and exits successfully without an update.
The cold-start gate checks for an update before entering the app (with its
offline/time limits); a background download offers 「重启以更新」 in the drawer.

### Native iOS build and TestFlight submission

`.github/workflows/mobile-native.yml` uses EAS CLI 27.2.0 with the production
profiles in `eas.json`. It runs on main changes to `app.json`, `app.config.ts`
or `eas.json` under `apps/mobile`, or through `workflow_dispatch` on main.
Native dependency or asset changes outside these path filters require that
manual dispatch; publishing JavaScript does not replace this step.

The workflow requires the existing `EXPO_TOKEN`, runs the mobile typecheck,
and waits for `scripts/release/ci-gate.mjs` to confirm the successful main CI
run for the exact source commit. EAS Build uses the existing signing setup
with `--freeze-credentials`, the production update channel, store distribution
and the remotely incremented iOS build number. Missing signing credentials
fail the build instead of being created in this workflow.

After `eas build --wait --json`, the workflow verifies an iOS build is
`FINISHED` and its `gitCommitHash` equals the workflow's `GITHUB_SHA`.
It submits that returned build id with `eas submit --id`, never whichever
build happens to be latest. Main push runs submit automatically; a manual
run can set `submit: false` to build without submitting. The non-secret
`mobile-native-<sha>` artifact records the build and source metadata.

The runtime version is the native fingerprint. A native dependency or native
configuration change, including `userInterfaceStyle`, needs a compatible new
binary. An OTA published for a different runtime does not update the old
binary. Compare the native build's runtime/fingerprint with the production
update before claiming the installed app can receive it.

Successful EAS submission means the binary was uploaded to App Store Connect.
TestFlight processing/availability, installation on a device and acceptance
are separate results. This workflow does not submit an App Store production
release for App Review. See [Expo's iOS submission guide](https://docs.expo.dev/submit/ios/).

### Acceptance evidence

Record the source commit, web/API deployment, update id/channel/runtime,
native build id and version, submission result, and the installed TestFlight
build used for native acceptance. Docker Expo Web can check application
flows, accessible markup and responsive screenshots. VoiceOver, Dynamic
Type, UIKit navigation, haptics and native Reduce Motion require real iOS
evidence. A published artifact alone does not establish device acceptance.
