# One app shell (affectUI App Shell) and affectUI's palette

- Date: 2026-11-09
- Source: Alex, relayed by the coordinator: "use affectUI's own palette everywhere", with one shell around the app.
- Rule: —
- Replaces: the icon rail plus window card as the hosted app's outer frame; Mikka's own colour values in the hosted edition.

The hosted edition gets one outer frame: affectUI's App Shell. Mikka passes its navigation in as data:
- the destinations, with the active one from the route;
- the workspace;
- the account;
- settings and sign-out.

Screens built from affectUI blocks draw their page only, inside that one shell. They don't draw a second shell.

Colours come from affectUI's palette everywhere:
- Light: page #f8f8f8, card white, accent #0060e2.
- Dark: page #0e0e10, card #1b1b1e, accent #5b9aff.
- Panels have a 12px radius, and the type stays Inter.

BoardUI's semantic tokens and the shadcn token names both map onto these values. Only token values change; components keep their styles.

What follows:
- Step 1 is the shell and the palette.
- These parts of the shell are not wired yet and come later:
  - bots and chats in the shell's navigation;
  - unread counts;
  - the shell's ⌘K entry;
  - the workspace switcher.
- Settings keeps its own frame for now.
- The implementation lives in the private hosted UI repository. Paid component source stays out of this repository.
