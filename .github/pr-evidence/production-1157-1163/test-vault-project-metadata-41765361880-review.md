# Existing test-vault access discovery

The metadata-only [workflow 41765361880](https://github.com/alexj11324/Mikka/actions/runs/41765361880), at fixed temporary workflow commit `c52eb070bb59b5f033318dc9c3a3af1f429c44da`, used the existing `mikka-github-cloud` OIDC identity `2cf9fa19-b9db-4c08-8ca0-b31859f2cbac`. Its normal GitHub token request, Infisical OIDC login, and one `GET /api/v1/projects` each returned 200 on 2026-11-04 at 03:09:54–03:09:55 UTC.

The known Mikka project was visible. The exact documented project name `Mikka Test Account Vault` was not visible to this existing identity. This is evidence about this identity's current visible project set, not a claim that the vault does not exist or that all possible identities lack access. No other project names were included in the report.

No application call, model call, stored secret read, grant change, new identity, or credential export occurred. This therefore does not establish a login as the requested primary account or subscription/provider acceptance. The existing Smoke account path remains available for the separately documented production tests.
