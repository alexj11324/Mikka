# The iOS app follows the system's appearance and colours

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session: the iOS app follows the system dark mode; then 「颜色本身要跟系统走」: on iOS use the system's dynamic colours (PlatformColor) instead of the app's own hex values, so light/dark, Increase Contrast and the accent all follow the system. The Figma dark frames (file zPe5LKycb2XuT1ivCLRw07, page 843:2) give layout only.
- Rule: —
- Replaces: the light-only app (`userInterfaceStyle: light`)

`apps/mobile/lib/theme.ts` holds every colour as a token. On iOS a token is a
system colour (systemBackground, systemGroupedBackground,
secondarySystemGroupedBackground, label, secondaryLabel, separator,
systemBlue and the other system hues). The web build reads CSS variables that
switch with prefers-color-scheme and prefers-contrast. Android has the light
values.

Words are at least 4.5:1 against their background in dark mode, so:

- tertiaryLabel is used only for icons and disabled fills, and placeholders
  take secondaryLabel;
- a filled accent carrying white words (my bubble, the send button) is a
  deeper blue than systemBlue, since white on systemBlue reads 3.7:1 in dark.
  It goes deeper again with Increase Contrast.

In dark mode the ink bot colour draws as crème, as on the web.
