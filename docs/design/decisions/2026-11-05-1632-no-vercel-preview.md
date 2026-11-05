# No Vercel Preview for pull requests or branches

- Date: 2026-11-05
- Source: Alex, 2026-11-05, after an agent searched Vercel for a pull
  request's Preview: 「我以为构建都是交给 GitHub 在做」「文档里面还有这种…使用 Vercel
  进行 Preview 构建的问题的话，应该删掉吧」
- Rule: — (process, not product)
- Replaces: the "or on a preview with its own database branch" clause of
  [2026-11-03-2359](2026-11-03-2359-issue-owner-merges-and-accepts-in-production.md)
  ("Still in force").

1. **No Preview.** Pull requests and branches get no Vercel deployment.
   `vercel.json` turns off Vercel's Git deployments for every branch, `main`
   included.
2. **Builds run on GitHub Actions.** Only `main` deploys:
   `.github/workflows/web-deploy.yml` builds it and uploads the prebuilt
   output to Vercel production ([web deploy](../../operations/web-deploy.md)).
3. **Verification before merge** runs in CI (for example `Production build
   and browser interactions`) or as a production build (`next build`,
   `next start`) in a local or Docker sandbox, against its own isolated
   PostgreSQL database (`mikka_e2e`) and leased test accounts
   ([test accounts](../../test-accounts.md)). Production is never the test
   environment.
4. **Hands off Vercel.** Do not create deployments with the Vercel CLI or API,
   and do not change Vercel project settings.

This is about Mikka's own development. Product features that publish a user's
project to Vercel, or show v0 or Cloudflare previews, are unchanged.
