# UI slots and the hosted UI layer

The official web app and desktop installers lay a private BoardUI layer over
this repository's interface ([decision 2026-11-06-2000](design/decisions/2026-11-06-2000-hosted-ui-overlay.md)).
The paid code lives only in `alexj11324/mikka-hosted-ui`; this repository
never imports it. The build pipeline that checks the layer out is issue #1527.

## The two builds

| | Open-source build | Official build |
| --- | --- | --- |
| `MIKKA_UI_OVERLAY_DIR` | unset | path of the `mikka-hosted-ui` checkout, inside this repository (CI uses `.hosted-ui/`, which is gitignored) |
| `@ui-slot/<name>` | `components/slots/<name>.tsx` | `$MIKKA_UI_OVERLAY_DIR/slots/<name>.tsx` when the layer has it, else the default |
| `@hosted/*` | does not resolve | `$MIKKA_UI_OVERLAY_DIR/*` |

`lib/ui-overlay.mjs` decides this once, and both bundlers read it:
`next.config.mjs` (Turbopack `resolveAlias` and webpack `resolve.alias`) and
the desktop renderer's Vite plugin (`apps/frontend/scripts/application-plugin.mjs`).
`tsconfig.json` maps `@ui-slot/*` to the defaults, so typecheck, lint and tests
in this repository always see the open-source build. The layer must sit inside
the repository: Turbopack reads nothing outside its root, and the layer
resolves `react` and this app's modules from this repository's `node_modules`.
A missing directory, or one outside the repository, fails the build.

## Slots

| Slot | Default | Props | Callers import |
| --- | --- | --- | --- |
| `bot-avatar` | bloub blob | `BotAvatarProps` in `components/slots/bot-avatar-contract.ts` (`id` is the bot's id when the caller has one; `coordinator` is set by `COORDINATOR_AVATAR`) | `BotAvatar`, `CoordinatorAvatar`, `colorFor`, `COORDINATOR_AVATAR` from `@/components/nav/bot-avatar` |
| `settings-frame` | app rail and window bar around settings (`AppFrame`) | `SettingsFrameProps` in `components/slots/settings-frame-contract.ts` | `SettingsFrame` from `@/components/settings/settings-shell` |
| `settings-sidebar` | settings section list | `SettingsSidebarProps` in `components/slots/settings-sidebar-contract.ts` | `SettingsSidebar` from `@/components/settings/settings-sidebar` |
| `settings-content` | heading and card around a section (`AppShellContent variant="settings"`) | `SettingsContentFrameProps` in `components/slots/settings-content-contract.ts` | `SettingsView` |
| `settings-models` | 模型与订阅 body (subscriptions, API keys, fallback, model order, profiles, sharing) | `SettingsModelsProps` in `components/slots/settings-models-contract.ts` | `SettingsView` |

A slot changes how something looks, never what it does. Data, state and
behaviour stay in this repository and reach the slot as props. A layer slot
exports the same named component as the default, takes the same props and is
a client component (`'use client'`).

The settings slots are filled together: a layer's frame draws the whole settings page, and its sidebar and content slots hand it their section list and title rather than drawing their own.

Adding a slot: move today's component to `components/slots/<name>.tsx`, put
its props in a contract file next to it, keep the public import path
re-exporting it from `@ui-slot/<name>`, add the name to `UI_SLOTS`, and add a
row above.

## Rules for the layer

- **Imports.** BoardUI's own source imports its files with `@/` (for example
  `@/components/base/...`, `@/utils/cx`). Here `@/` is this repository, so
  inside the layer those imports are written `@hosted/...`. The layer's
  `pnpm bdui add <name>` rewrites them after each add (see its `CLAUDE.md`).
  `@/` in the layer means this repository: use it for this app's types,
  hooks and contracts, such as `@/components/slots/bot-avatar-contract`.
- **Styles.** The layer has one style entry, `styles/overlay.css`, which its
  slots import. It holds BoardUI's theme tokens and fonts and an `@source` for
  the layer's files: Tailwind skips gitignored paths, so without it BoardUI's
  classes are never generated. It does not import BoardUI's `globals.css`
  base reset, and it does not redefine this app's tokens, so pages outside
  the slots look the same in both builds.
- **Dependencies.** Packages BoardUI needs that this repository lacks are
  installed in the layer. `react` and `react-dom` come from this repository
  only.
- **Source maps.** No public output of an official build may carry the
  layer's source (issue #1527, item 5).
