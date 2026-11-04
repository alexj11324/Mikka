# Production web deploy

Production builds of the web app run on GitHub Actions, not on Vercel's build
machines. Mikka is a public repository, so GitHub's standard runners are free,
while each Vercel build cost about 5 minutes of a 4-core machine, around 100
times a day. Vercel still hosts the deployment and serves `app.aspectlylabs.com`.

## Flow

`.github/workflows/web-deploy.yml` runs on every push to `main` and on manual
dispatch. Runs are serialized: a newer push waits for the running upload and
replaces any older queued run.

1. **Token.** Reads `VERCEL_DEPLOY_TOKEN` from Infisical `prod:/platform`
   through the existing GitHub OIDC identity. This is a dedicated Mikka-team
   token, so it can be rotated without touching `VERCEL_TOKEN` or
   `VERCEL_TEAM_TOKEN`. It expires on 2027-02-02.
2. **Skip.** Applies the same documentation-only rule the old Vercel Ignored
   Build Step used (`scripts/vercel-ignore-build.mjs`). The comparison is
   against the commit production serves now, not the previous push, so a
   failed deploy is never skipped over.
3. **Environment.**
   - `vercel pull` fetches project settings and the production environment.
     Vercel returns sensitive values empty.
   - The job reads `prod:/vercel` from Infisical. This is the source that
     Vercel production is synced from.
   - `scripts/release/web-deploy.mjs env` fills only the keys that production
     defines and Vercel withheld. It pins `VERCEL_GIT_COMMIT_REF=main` and the
     commit SHA, which the migration guard requires.
   - It refuses to build if a required value is missing. The error names the
     variable, never its value.
4. **Build.** Runs `vercel build --prod`, which is the same `pnpm build` as
   before, ending with typecheck and then migrations against the production
   database.
5. **Deploy.** Runs `vercel deploy --prebuilt --prod`. The Git metadata (org,
   repo, ref, SHA) lets the device gateway release
   (`docs/operations/device-gateway-release.md`) identify the serving commit.

The deployment's runtime environment comes from the Vercel project as before.
The workflow uploads build output only.

`vercel.json` keeps `git.deploymentEnabled.main` off, so Vercel does not also
build each push.

## Logs are public

Actions logs on this repository are public. Infisical values are masked by the
action, and `vercel pull` output is discarded. Do not add steps that print the
environment or `.vercel/.env.production.local`.

## Rollback

There are two ways back:

- **Promote an earlier deployment.** In Vercel, promote an earlier production
  deployment (instant rollback). No build is needed.
- **Return to Vercel building main.** Set `git.deploymentEnabled.main` back to
  `true` in `vercel.json` and disable this workflow in the same PR.
