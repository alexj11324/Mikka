# One black app icon for the website and app

- Date: 2026-11-12
- Source: Alex's SEO cleanup request: keep the black PNG app icon consistent across the website and app.
- Rule: `brand.md` browser and home-screen assets
- Replaces: `brand.md` browser SVG and theme-switching icon requirement

Browser tabs and home-screen icons use the website's approved black app
artwork in both themes. The app ships the same 48px, 96px and 192px PNGs,
16px/32px/48px ICO, and 180px Apple icon through its existing static assets.
The Vite app shell declares these files under `/mikka/`.

The inline product mark keeps its inherited text color. App pages retain
their existing `noindex,nofollow` metadata and sharing behavior.
