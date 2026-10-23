# Mikka development

- Develop and accept changes on cloud Preview deployments. Do not start a development server, database, browser acceptance environment, build or `tsgo` on the developer's Mac. Run builds and type checks in remote CI; use deployed previews for runtime checks. Small source-only unit tests may run without a server.
- Store project credentials in the Mikka Infisical Cloud project. Use cloud Secret Syncs and workload identities for delivery and Agent access. Never commit secret values or add credentials to local environment files.
- Google and GitHub sign-in use the stable HTTPS OAuth proxy hub configured by `BETTER_AUTH_OAUTH_PROXY_URL`. Give trusted previews the dedicated shared proxy secret through cloud configuration. Each preview uses its own exact runtime origin; changing v0 hosts do not require shared-domain wildcards.
- Preserve environment and Neon branch boundaries. Preview application data must use the matching cloud database with the required schema. Verify the deployed path after changing credentials or callbacks.
- Preserve unrelated changes and keep secret values out of terminal output, screenshots and reports.
- Follow `docs/acceptance.md` for runtime acceptance. Use direct Google/GitHub OAuth and reuse authorized browser sessions; do not require the user to enter a Mikka password for routine acceptance. Diagnose account-linking conflicts separately without weakening account ownership checks.
- Hand off the Agent's branch, commit SHA and unique Preview deployment URL. Keep that version fixed during acceptance; v0 `Latest`, moving branch aliases and the shared production domain cannot identify a frozen Agent delivery.

## Dividers (MIK-4)

Source: Design Lead's final spec (no Figma). Component default styles still win. Enforced by `scripts/ui-policy.mjs` (`pnpm lint:ui`, tests in `pnpm test:ui-policy`).

**When to use a divider**
- Dense, scannable rows of the same kind: task rows, settings rows, table rows. Row height ≤ 48px and no background of their own.
- Functional sections inside one container: menu groups, toolbar groups, property sections in a dialog or sidebar.

**When not to** — use spacing (`gap-3` / `gap-4`) instead, and `Card` when you need grouping:
- Content blocks, comments, activity timeline items, card grids.
- Between elements that already have a border or background (no double lines).
- Before the first item or after the last item of a container.

**Which one, by priority**
1. A component's built-in separator with its defaults: `DropdownMenuSeparator`, `CommandSeparator`, `SelectSeparator`, `Table` row lines, `Accordion` item borders, `SidebarSeparator`, etc.
2. Hand-built row lists: `divide-y` on the parent. No divide color, width or style utilities; the color comes from the global `border-border` token, so do not write `divide-border` either.
3. A standalone, non-repeating section break: `<Separator />` (horizontal or vertical) with no color or thickness classes.
4. `border-b` / `border-t` only on layout boundaries (page header, panel title bar vs content, footer), never between list items.

**What `lint:ui` rejects**
- `style/divider-list-item`: `border-t/b/y` on a list item, detected as the `last:border-0` / `first:border-t-0` pattern or as the root element returned from `.map()`. Use `divide-y` on the parent.
- `style/divider-default`: any `divide-*` other than `divide-x`, `divide-y`, `divide-*-0`, `divide-*-reverse`; any `bg-*`, `border-*`, `opacity-*` or thickness (`h-*` horizontal, `w-*` vertical) class on `<Separator />`.
- `style/divider-element`: `<hr>` (via `components/no-handwritten-ui`) and hand-drawn `h-px`/`w-px` + `bg-*` lines. Use `<Separator />`.
- `style/divider-between-bordered`: `divide-*` whose children are `Card`s or have a box border / ring / background, and `<Separator />` next to such an element.
- `style/divider-edge`: `<Separator />` as the first or last child of its container.
- Not statically detectable, so reviewers check it: dividers between timeline items, comments or content blocks that are not otherwise bordered.

**Exemptions**
- `components/ui/**` and the other `componentRoots` in `ui-policy.json` are not checked.
- `components/chat/unread-divider.tsx` (the unread divider) is exempt by file.
- A `border-b`/`border-t` that is not a list item is treated as a layout boundary and is allowed.
- The task-detail timeline's vertical connector (`border-l` / `w-px` positioned line) is a connector, not a divider; vertical side borders are not checked.
- Any other justified exception: put a real code comment `// ui-policy-allow divider: <reason>` (or `{/* … */}` inside JSX) directly before the JSX element. Only comments parsed by TypeScript count (the same text in a string or attribute does not); it applies only to the immediately following element (its attributes may span multiple lines), never to siblings; the reason must be at least 10 characters. `pnpm lint:ui` prints the exemption count and each `file:line` with its reason. @Design Lead in the PR for review.
- Sticky group headers inside a list (`sticky` in the class) may keep `border-b`; they are layout boundaries, not list dividers.

**需要人工 review (lint:ui cannot see these)**

- Hand-repeated `<li>` / rows written out one by one (no `.map` / `Array.from`), each with `border-b`.
- A border drawn inside a child component (`<Row />` whose own root has `border-b`), when the list lives in another file.
- An empty `<div />` used as a divider by other means (e.g. inline style, `h-[1px]` via a variable lint can't resolve).
- A `<Separator>` restyled through the `style` prop instead of `className`.
- A conditionally rendered first/last `<Separator>` (e.g. `{i > 0 && <Separator />}` or `{showFooter && <Separator />}` at the edge).
