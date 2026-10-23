# Mikka development

- Develop and accept changes on cloud Preview deployments. Do not start a development server, database, browser acceptance environment, build or `tsgo` on the developer's Mac. Run builds and type checks in remote CI; use deployed previews for runtime checks. Small source-only unit tests may run without a server.
- Store project credentials in the Mikka Infisical Cloud project. Use cloud Secret Syncs and workload identities for delivery and Agent access. Never commit secret values or add credentials to local environment files.
- Google and GitHub sign-in use the stable HTTPS OAuth proxy hub configured by `BETTER_AUTH_OAUTH_PROXY_URL`. Give trusted previews the dedicated shared proxy secret through cloud configuration. Each preview uses its own exact runtime origin; changing v0 hosts do not require shared-domain wildcards.
- Preserve environment and Neon branch boundaries. Preview application data must use the matching cloud database with the required schema. Verify the deployed path after changing credentials or callbacks.
- Preserve unrelated changes and keep secret values out of terminal output, screenshots and reports.
- Follow `docs/acceptance.md` for runtime acceptance. Use direct Google/GitHub OAuth and reuse authorized browser sessions; do not require the user to enter a Mikka password for routine acceptance. Diagnose account-linking conflicts separately without weakening account ownership checks.
- Hand off the Agent's branch, commit SHA and unique Preview deployment URL. Keep that version fixed during acceptance; v0 `Latest`, moving branch aliases and the shared production domain cannot identify a frozen Agent delivery.

## UI component styles

- Use the default styles that ship with the component libraries (beUI, shadcn, HeroUI). Do not restyle a component to reproduce an old screen, and do not edit the source of registry components.
- Migrate old screens to the new components' styles; do not bend new components to match old styles.
- When a design spec differs from a component's default look, the component default wins. Accessibility handling (for example a crossfade instead of motion under reduced motion) may wrap the component from outside without changing the component itself.

## Merge flow for frontend changes

- Every PR that touches the frontend passes QA review first. Then post its Preview link to the design group for the UI Designer's design review. Only after the design review passes is the PR reported to Alex for merge approval. List the pages and states to review in the PR description.
- For any change with animation, the design review also includes a motion review. The bar is smooth and elegant. Check four things: no dropped frames or stutter on the Preview; no jumps on state changes, with natural easing; motion stays tidy at small sizes and when elements stack; reduced-motion degrades correctly.
- Do not merge until every required check, including the full e2e suite, is green.
- Merging, pushing to `main` and deploying to production need Alex's approval. Pushing feature branches and opening PRs do not.

## Database migrations

- Migration numbers follow merge order and are assigned centrally by the Tech Lead. Nobody else renumbers migrations.
- Do not write specific migration numbers into docs; Linear is the source of truth.
