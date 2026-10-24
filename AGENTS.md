# Mikka development

- Cloud Agents must run relevant builds, type checks, databases and browser/runtime acceptance on their own cloud Linux environment. Do not use the developer's Mac for those checks. v0 Preview is no longer the development or acceptance path. A separately authorized deployment can provide additional integration acceptance; it does not replace Linux checks.
- Store project credentials in the Mikka Infisical Cloud project. Use cloud Secret Syncs and workload identities for delivery and Agent access. Never commit secret values or add credentials to local environment files.
- Google and GitHub sign-in use the stable HTTPS OAuth proxy hub configured by `BETTER_AUTH_OAUTH_PROXY_URL`. Give trusted previews the dedicated shared proxy secret through cloud configuration. Each preview uses its own exact runtime origin; shared-domain wildcards are not required.
- Preserve environment and Neon branch boundaries. Preview application data must use the matching cloud database with the required schema. Verify the deployed path after changing credentials or callbacks.
- Preserve unrelated changes and keep secret values out of terminal output, screenshots and reports.
- Follow `docs/acceptance.md` for runtime acceptance. Use direct Google/GitHub OAuth and reuse authorized browser sessions; do not require the user to enter a Mikka password for routine acceptance. Diagnose account-linking conflicts separately without weakening account ownership checks.
- Hand off the Agent's branch, commit SHA, Linux check results and remaining blockers. Include a unique deployment URL only when deployment was authorized and performed. Moving aliases and the shared production domain cannot identify a frozen Agent delivery.
