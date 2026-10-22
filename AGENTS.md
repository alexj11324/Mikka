# Mikka development

- Develop and accept changes on cloud Preview deployments. Do not start a development server, database, browser acceptance environment, build or `tsgo` on the developer's Mac. Run builds and type checks in remote CI; use deployed previews for runtime checks. Small source-only unit tests may run without a server.
- Store project credentials in the Mikka Infisical Cloud project. Use cloud Secret Syncs and workload identities for delivery and Agent access. Never commit secret values or add credentials to local environment files.
- Google and GitHub sign-in use the stable HTTPS OAuth proxy hub configured by `BETTER_AUTH_OAUTH_PROXY_URL`. Give trusted previews the dedicated shared proxy secret through cloud configuration. Each preview uses its own exact runtime origin; changing v0 hosts do not require shared-domain wildcards.
- Preserve environment and Neon branch boundaries. Preview application data must use the matching cloud database with the required schema. Verify the deployed path after changing credentials or callbacks.
- Preserve unrelated changes and keep secret values out of terminal output, screenshots and reports.
- Follow `docs/acceptance.md` for runtime acceptance. Use direct Google/GitHub OAuth and reuse authorized browser sessions; do not require the user to enter a Mikka password for routine acceptance. Diagnose account-linking conflicts separately without weakening account ownership checks.
