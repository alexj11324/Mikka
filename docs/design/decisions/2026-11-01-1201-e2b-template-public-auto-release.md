# The cloud worker template is public and released by CI

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: every new cloud worker
  template is made public directly, and its release becomes automatic in CI.
- Rule: —
- Replaces: the manual release steps (build, make public, set the two
  Production variables, redeploy)
- See also: [own E2B key is enough](2026-11-01-1200-own-e2b-key-is-enough-for-cloud.md)

People start sandboxes from Mikka's worker template with their own E2B key, so
the template must be public. It holds only the daemon and protocol sources and
their pnpm dependencies, packaged with `git archive` from the listed paths of
one `main` commit, and no credential.

A push to `main` that changes a packaged path (`WORKER_PATHS` in
`scripts/e2b/build-template.py`) or `scripts/e2b/` runs
`.github/workflows/e2b-template.yml`; it can also be run by hand on `main`. It
builds the template with the platform E2B key, makes it public, checks it is
public and its build ready, then sets `E2B_BYO_COMPUTER_TEMPLATE` and
`MIKKA_CLOUD_WORKER_SHA` (the worker hash) in Vercel Production in one request
and redeploys Production. If any step before that fails, Production keeps its
previous pair; a worker whose SHA does not match the template is refused.

The worker hash is a digest of the template's inputs at that commit (the
packaged paths, `bootstrap.sh` and `build-template.py`), not the commit itself.
A push whose hash equals Production's skips the build, the variables and the
redeploy, so a release happens only when the worker actually changes.

A person's cloud computer keeps the template it was created from. On its next
wake after a release, a computer built from an older worker commit, or one E2B
no longer has, is replaced by a new one on the current template, unless a run
is still live on its worker; the old desktop and files go with it.
