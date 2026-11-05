# iOS: rebuild the mobile frontend on OpenBot's architecture

- Date: 2026-11-05
- Source: Alex, issue #1408: "rebuild Mikka's mobile frontend to follow OpenBot's mobile app … and replace our current approach."
- Rule: —
- Replaces: —

The iOS app adopts the architecture of OpenBot's mobile app. The ownership model is set out in `apps/mobile/DESIGN.md`:

| Part | Owner |
| --- | --- |
| Navigation | Expo Router's native Stack, Toolbar, SearchBar, form sheets and NativeTabs |
| System controls | `@expo/ui` |
| Product content | HeroUI Native, themed from Mikka's tokens through Uniwind |
| Chat list | Legend List, following the v0 motion model |
| In-content glass | `expo-glass-effect`, used sparingly |

Code is laid out feature-first.

This builds on `2026-11-05-1230-ios-native-first`, which stays in force.

Two defaults, accepted by the coordinator on 2026-11-05; Alex can still change either:

- **HeroUI Native and beUI.** HeroUI Native owns the general content controls. beUI stays in the repository, on the same
  palette, and is used only for the AI-specific pieces HeroUI has no part for. A general control never becomes a new
  beUI use.
- **Folders.** `features/` and `shared/` sit at the root of `apps/mobile`, next to `app/`. They are not moved under
  `src/`, so the Expo Router root and the `@/` imports stay as they are.

**License.** OpenBot is under PolyForm Noncommercial 1.0.0. We take its architecture, libraries and interaction model
only. No OpenBot source or document text goes into this repository, and every PR for this work says that it contains no
copied code.

**Phases.** The work ships in phases:

0. Foundation
1. Chat
2. Navigation chrome
3. Remaining screens
4. Cleanup

Each phase goes out by OTA. The Phase 0 packages (HeroUI Native, Legend List, tailwind-variants, tailwind-merge) are
JavaScript only and leave the iOS fingerprint unchanged, so this work needs no new TestFlight build.
