# Development is local first; CI is the final gate

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: write the development
  speed-up rules into the docs as standing rules and change every old rule
  that conflicts with them.
- Rule: — (process, not product)
- Replaces, in part:
  - [2026-11-01-0230-browser-tests-manual-only](2026-11-01-0230-browser-tests-manual-only.md): browser acceptance runs locally first; the manual Actions run is only for suites that need a GitHub-hosted runner.
  - [2026-11-01-0330-ui-figma-and-skill-review-before-code](2026-11-01-0330-ui-figma-and-skill-review-before-code.md) step 4–5: screenshots come from a local production build, and "merge" means the next integration batch.
  - [2026-11-01-0015-main-is-the-design](2026-11-01-0015-main-is-the-design.md) rule 4: "merged" means merged to `main` through the integration PR.
  - [2026-11-01-1201-e2b-template-public-auto-release](2026-11-01-1201-e2b-template-public-auto-release.md): branches are tested on a `-dev` template built from the branch, without waiting for the release from `main`.
  - `CONTRIBUTING.md` per-PR merging, and Preview deployments as the place to develop and accept (`docs/cloud-preview.md`).

[`docs/dev-workflow.md`](../../dev-workflow.md) holds the rules:

1. Build, run services and the daemon, and accept end to end locally. A PR can
   be opened any time and never blocks local verification. CI is only the final
   gate; nobody waits on CI, a merge or a deploy to check what can be checked
   locally.
2. Hot reload: `next dev` for the server and `tsx` on source for the daemon. A
   production build only for production screenshots of UI changes or specs that
   need one.
3. One-command setup (`scripts/dev/bootstrap-local.sh`): Node 24, PostgreSQL 17
   at `127.0.0.1:5433/mikka_e2e`, migrations, bubblewrap, socat and ripgrep;
   Playwright on `/opt/pw-browsers/chromium`, never `playwright install`.
4. Never fake `GITHUB_ACTIONS`, `RUNNER_ENVIRONMENT`, `GITHUB_RUN_ID` or any
   other CI variable; GitHub-runner-only suites stay in CI.
5. Merge in batches of five through `integration/<date>-<n>`, joined with merge
   commits; stacked PRs by their top PR; UI screenshots reviewed first; the
   coordinator squash-merges and closes the originals.
6. The coordinator assigns rule ids and migration timestamps at dispatch.
7. Test worker changes on a branch `-dev` E2B template; never overwrite the
   production template or Vercel's production environment.
8. Reach local services from outside through a Cloudflare tunnel; in the cloud
   environment `cloudflared` cannot connect (port 7844), which is reported as
   it is, with no workaround and no production credentials on a public machine.
9. Independent work runs in parallel with subagents; a step stalled for five
   minutes is stopped; unknown causes are checked against official docs, with
   the link.
