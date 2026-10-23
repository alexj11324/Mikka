# Runtime acceptance

Run acceptance on a deployed cloud Preview. Builds and type checks run in remote CI; do not start a local server, database, build or `tsgo` on the developer's Mac.

## Freeze the version under review

- Each Agent hands off its branch, commit SHA and unique deployment URL. Keep using that deployment during acceptance so another Agent's publish or branch update cannot replace the reviewed code. A moving branch alias, v0 `Latest`, and the shared production domain are not a frozen acceptance version.
- In a GitHub-backed v0 project, open the working branch menu next to Publish and use its Preview Deployment. v0 documents separate working branches and previews for parallel chats sharing one repository and Vercel project. Publish merges into the base branch and updates production; it is not required to review a branch.
- The embedded v0 sandbox Preview is useful during iteration. OAuth acceptance there remains a separate runtime gate: open the actual preview in a top-level tab and verify its origin, callback return, session and reviewed version. A passing Vercel Preview does not establish that the embedded sandbox passed.
- The stable OAuth callback hub routes authentication back to the originating Preview; it must not switch the code version under review to production or another Agent's Preview.

References: [v0 branches and previews](https://v0.app/docs/github), [v0 deployment behavior](https://v0.app/docs/deployments), [Better Auth OAuth proxy](https://better-auth.com/docs/plugins/oauth-proxy).

## Authentication

- Sign in directly with Google or GitHub OAuth in a top-level browser window. Reuse existing authorized provider/browser sessions. Do not ask the user to enter a Mikka password as a routine acceptance step or as the default response to an OAuth error.
- If the provider itself requires MFA or reauthentication, hand over that specific provider step once. Never request passwords or verification codes in chat, and resume using the resulting session.
- For `account_not_linked`, diagnose the provider identity, existing account and verification state. Preserve account ownership checks. Use an already working authorized OAuth provider for general acceptance; report the conflicting provider as blocked rather than repeatedly sending the user through password login. Passing GitHub does not establish Google acceptance.
- Verify the intended identity and an actual Mikka session after OAuth. For Preview proxy acceptance, prove the round trip from the Preview through `https://app.aspectlylabs.com` and back to the originating Preview.
- Exercise authenticated sign-out on the supported Preview URL, including its Vercel branch alias. Unrelated origins must remain rejected.

Record the deployed commit, Preview origin, provider, result and remaining blockers without credential values. Secret storage, successful sync, CI and deployment readiness are separate from runtime acceptance.
