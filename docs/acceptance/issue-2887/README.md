# Issue 2887 fixture acceptance evidence

Use this record to distinguish the verified database and guard contracts from
the remaining production-build screenshot acceptance. It accompanies
[issue 2887](https://github.com/alexj11324/Mikka/issues/2887) and
[PR 2969](https://github.com/alexj11324/Mikka/pull/2969).

## Verified on 2026-11-20 UTC

The owning workflow ran PostgreSQL 17 with the complete repository migrations
on its isolated loopback `mikka_ui_e2e` database. At source `ce3575812`, this
command exited with code 0:

```sh
node scripts/fixtures/seed-smoke.mjs
```

The command checks the actual stored task count, fixed task timestamps, eight
workspace states, and the custom `质量验收` state in the `review` category.
It does not substitute query results or use a remote database.

| Scenario | Stored tasks | Stored states | Seed result |
| --- | ---: | ---: | --- |
| `empty` | 0 | 8 | Passed |
| `board` | 8 | 8 | Passed |
| `task` | 8 | 8 | Passed |
| `automations` | 8 | 8 | Passed |
| `bot-settings` | 8 | 8 | Passed |
| `pulls` | 8 | 8 | Passed |

At source `921ec4442`, the following command passed all five tests, with no
skipped or cancelled tests:

```sh
node --test scripts/fixtures/guard.test.mjs \
  scripts/fixtures/proxy.test.mjs \
  scripts/fixtures/bundle-check.test.mjs
```

Those tests reject a release manifest, deployed environment, non-loopback or
non-`_e2e` database, inconsistent database URLs, foreign Host and cross-site
login requests. The login test reaches a real HTTP password endpoint and
checks the returned identity before forwarding its cookie. The output test
injects the fixture-login marker into server and browser files and requires
both scans to fail. Actual build finalization also invokes the output scan.

## Run the implemented fixture entry

Prepare an existing local PostgreSQL 17 `*_e2e` database and set
`E2E_DATABASE_URL`, `MIKKA_DATABASE_URL`, and `DATABASE_URL` to that same target.
No model, GitHub, Slack, E2B, or real-account credential is required. To use the
official UI, set `MIKKA_UI_OVERLAY_DIR` to the authorized read-only private UI
checkout. From the public repository root, run:

```sh
pnpm fixture board
pnpm screenshots all
```

The fixture command creates the explicit `local-fixture` build, migrates the
isolated database, seeds fixed identities and data, and starts the loopback
launcher. It prints the local origin. `MIKKA_FIXTURE=board pnpm start` starts
an already compiled fixture target. An ordinary production manifest is
rejected, regardless of `NODE_ENV`; a locally optimized fixture build can
still use `NODE_ENV=production`.

After building that target once, use `pnpm screenshots all --built` to reuse
it. `MIKKA_CHROMIUM_EXECUTABLE` selects an installed Chromium executable.
The script captures all six scenes plus the automation editor twice in fresh
browser contexts, with fixed time, viewport, locale, fonts and motion settings.
Each pair must have at most a 0.001 changed-pixel ratio. It writes PNG pairs and
the source/build/browser manifest under `.cache/screenshots/official/` or
`.cache/screenshots/default/` according to the actual build receipt.

The fixture owns stable test identities in its isolated database. Ordinary
API/CLI acceptance continues to use the existing TestAccountPool. Login uses
Better Auth's normal password endpoint; the disposable password stays in the
launcher's memory and no fixture login route is compiled into the product.

## Outstanding acceptance

The execution service interrupted the first local build attempts before the
official six-scene screenshot run. This record does **not** establish a
successful fixture application startup, stable screenshots, or end-to-end
cloud-worker execution. Keep the PR draft until the applicable real checks
are complete.

Public required UI slots deliberately reject missing official providers under
the repository's one-UI rule. The screenshot runner preserves that error and
fails; it does not save an error page as successful UI evidence or manufacture
a second product interface. The requested default-slot screenshot coverage
therefore remains an explicit acceptance gap to resolve with the owning
workflow and current design authority.

No real model or paid E2B resource was used for these checks. The source and
private overlay revisions for any later screenshot run must come from its
generated manifest; a previously built official UI artifact is not evidence
that a new fixture source was compiled.
