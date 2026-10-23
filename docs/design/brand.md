# Brand: the Mikka mark

Mikka has one mark: an M drawn on a 5×5 dot grid. The 13 dots that form the M
are solid. The other 12 are ghosts at low opacity. This page says where the
mark goes, how big it is, and what color it takes. Sizes follow the shadcn
sidebar blocks the app is built on. Their header row is 48px (`h-12`), with
the logo in a 32px tile (`size-8`) and a 16px glyph inside.

## Assets

| File | Use |
| --- | --- |
| `public/brand/mikka-icon-light.svg` | Black mark for light backgrounds, 1024×1024 with padding. |
| `public/brand/mikka-icon-dark.svg` | White mark for dark backgrounds, 1024×1024 with padding. |
| `app/icon.svg` | Browser tab icon. The viewBox is cropped to the dots and follows the system color scheme. |
| `app/apple-icon.png` | iOS home-screen icon. |

The `public/brand` files leave a wide margin around the dots, so a 28px
`<img>` shows a mark only about 16px tall. In product UI, inline the SVG with
its viewBox cropped to the dots (`19.2 19.2 61.6 61.6`, as in `app/icon.svg`).
Then the size you set is the size people see.

## Color

- Solid dots use `fill="currentColor"`, so the mark takes the text color
  and switches with the light/dark theme on its own. Don't ship two images
  swapped with `dark:hidden`.
- Ghost dots are the same color at 10% opacity.
- The mark is never tinted with an accent color, given a gradient, or given
  a shadow.

## Sizes

Sizes are the visible size of the dot grid, not the `<img>` box.

| Placement | Size | Notes |
| --- | --- | --- |
| Conversation list header (top left) | 28px | Mark only, no "Mikka" wordmark. Same height as the header's `+` button (`h-7`). |
| Sign-in / sign-up (`auth-logo.tsx`) | 24px | Mark plus "Mikka" in `text-lg font-semibold`, gap 10px (`gap-2.5`). |
| Onboarding welcome | 56px | Mark only, centered above the "欢迎来到 Mikka" title. |
| Browser tab | 16 / 32px | `app/icon.svg`. |

Below 16px the ghost dots blur into a grey square, so drop them and draw only
the solid dots.

## Clear space

Keep at least one dot pitch of empty space around the mark: 1/5 of its size,
which is about 6px at 28px. No button, text or edge goes inside that space.

## Wordmark

Write "Mikka" as plain text in the app font, never as an image. Use it only
where a newcomer meets the product: the sign-in page and the website. Inside
the app the mark stands alone.
