# Brand: the Mikka mark

Mikka has one mark: an M drawn on a 5×5 dot grid. The 13 dots that form the M
are solid. The other 12 are ghosts at low opacity. This page says where the
mark goes, how big it is, and what color it takes.

## Assets

| File | Use |
| --- | --- |
| `public/brand/mikka-icon-light.svg` | Black mark for light backgrounds, 1024×1024 with padding. |
| `public/brand/mikka-icon-dark.svg` | White mark for dark backgrounds, 1024×1024 with padding. |
| `public/brand/mikka-app-icon-{48,96,192}.png` | Approved black app icon for browser tabs, matching the website. |
| `public/favicon.ico` | Browser fallback, with 16px, 32px and 48px sizes. |
| `public/apple-icon.png` | 180px home-screen icon, matching the website. |

The `public/brand/mikka-icon-*.svg` files leave a wide margin around the dots, so a 28px
`<img>` shows a mark only about 16px tall. In product UI, inline the SVG with
its viewBox cropped to the dots (`19.2 19.2 61.6 61.6`, as in `components/brand/mikka-mark.tsx`).
Then the size you set is the size people see.

Browser and home-screen icons use the approved black PNG artwork in both
themes ([decision](decisions/2026-11-12-0449-browser-app-icon.md)). Vite copies
these files from `public/`; the app shell declares them under `/mikka/`.

## Color

- In product UI, solid dots use `fill="currentColor"`, so the mark takes the text color
  and switches with the light/dark theme on its own. Don't ship two images
  swapped with `dark:hidden`.
- Ghost dots are the same color at 10% opacity.
- The mark is never tinted with an accent color, given a gradient, or given
  a shadow.

## Sizes

Sizes are the visible size of the dot grid, not the `<img>` box. Inside a
paid block's logo slot (for example the hosted sign-in card) the block's own
size and placement win ([2026-11-09-0050](decisions/2026-11-09-0050-paid-blocks-as-shipped.md)).

| Placement | Size | Notes |
| --- | --- | --- |
| Bot list header (top left) | 28px | Mark only, no "Mikka" wordmark. Same height as the header's `+` button (`h-7`). |
| Sign-in / sign-up (`auth-logo.tsx`) | 24px | Mark plus "Mikka" in `text-lg font-semibold`, gap 10px (`gap-2.5`). |
| Native sign-in (`SignIn.tsx`) | 56pt | Dot-grid mark above the existing 30pt "Mikka" wordmark, gap 12pt. |
| Onboarding welcome | 56px | Mark only, centered above the "欢迎来到 Mikka" title. |
| Browser tab | 16 / 32 / 48px | ICO fallback and PNG sizes 48, 96 and 192px. |

Below 16px the ghost dots blur into a grey square, so drop them and draw only
the solid dots.

## Implementation status

`components/brand/mikka-mark.tsx` implements the cropped, inherited-colour
mark at 28px and drops ghost dots in its 12px variant.
`apps/mobile/components/MikkaMark.tsx` renders the same 13 solid and 12 ghost
dots for native sign-in, using the dynamic text colour and its existing 56pt frame.
The public
`components/blocks/auth-19/components/auth-logo.tsx` still renders the two
padded image assets at 28px, so its visible mark differs from the 24px
placement above. The implemented onboarding in
`components/onboarding/onboarding.tsx` uses the new Bot's avatar on its
welcome step. Check those source paths when changing these placements;
the measurements above record the brand requirements.

## Clear space

Keep at least one dot pitch of empty space around the mark: 1/5 of its size,
which is about 6px at 28px. No button, text or edge goes inside that space.

## Wordmark

Write "Mikka" as plain text in the app font, never as an image. Use it only
where a newcomer meets the product: the sign-in page and the website. Inside
the app the mark stands alone.
