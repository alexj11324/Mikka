# Development is local first; CI is the final gate

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: write the development
  speed-up rules into the docs as standing rules and change every old rule
  that conflicts with them.
- Rule: — (process, not product)
- Superseded in part by: [2026-11-01-1545-trunk-based](2026-11-01-1545-trunk-based.md) (rule 5: trunk-based merging replaces integration batches)
- Replaces, in part:
  - [2026-11-01-0230-browser-tests-manual-only](2026-11-01-0230-browser-tests-manual-only.md): browser acceptance runs locally first; the manual Actions run is only for suites that need a GitHub-hosted runner.
  - [2026-11-01-0330-ui-figma-and-skill-review-before-code](2026-11-01-0330-ui-figma-and-skill-review-before-code.md) step 4–5: screenshots come from a local production build, and "merge" means the next integration batch.
  - [2026-11-01-0015-main-is-the-design](2026-11-01-0015-main-is-the-design.md) rule 4: "merged" means merged to `main` through the integration PR.
  - [2026-11-01-1201-e2b-template-public-auto-release](2026-11-01-1201-e2b-template-public-auto-release.md): branches are tested on a `-dev` template built from the branch, without waiting for the release from `main`.
  - `CONTRIBUTING.md` per-PR merging, and Preview deployments as the place to develop and accept (`docs/cloud-preview.md`).

[`docs/dev-workflow.md`](../../dev-workflow.md) holds the rules (10–13 of the
coordinator's list are folded in: 12 into § 5, 13 into § 2 and § 9):

1. Build, run services and the daemon, and accept end to end locally. A PR can
   be opened any time and never blocks local verification. CI is only the final
   gate; nobody waits on CI, a merge or a deploy to check what can be checked
   locally.
2. Hot reload: `next dev` for the server and `tsx` on source for the daemon. A
   production build only for production screenshots of UI changes or specs that
   need one, built with `next build` directly (`pnpm build` adds lint and
   migrations).
3. One-command setup (`scripts/dev/bootstrap-local.sh`): Node 24, PostgreSQL 17
   at `127.0.0.1:5432/mikka_e2e`, migrations, bubblewrap, socat and ripgrep;
   Playwright on `/opt/pw-browsers/chromium`, never `playwright install`.
4. Never fake `GITHUB_ACTIONS`, `RUNNER_ENVIRONMENT`, `GITHUB_RUN_ID` or any
   other CI variable; GitHub-runner-only suites stay in CI.
5. Merge in batches of five through `integration/<date>-<n>`, joined with merge
   commits; stacked PRs by their top PR; UI screenshots reviewed first; the
   coordinator squash-merges and closes the originals. Several small fixes
   are pushed to an integration branch together, not one CI round each.
6. The coordinator assigns rule ids and increasing migration timestamps at
   dispatch; if they merge out of order, the integration session renames them.
7. Test worker changes on a branch `-dev` E2B template; never overwrite the
   production template or Vercel's production environment.
8. Reach local services from outside through a Cloudflare tunnel; in the cloud
   environment `cloudflared` cannot connect (port 7844), which is reported as
   it is, with no workaround and no production credentials on a public machine.
9. Independent work runs in parallel with subagents; a step stalled for five
   minutes is stopped; unknown causes are checked against official docs, with
   the link. Long commands run in the background with a notification and a
   timeout, never a foreground sleep loop or log polling.
10. Do, then report: anything within these rules is done first and reported
    after; only product direction, permissions and production changes wait
    for an answer. Every report names the next step.
11. While CI runs, start the next task; with none, ask for one in the report.
