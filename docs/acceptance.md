# Runtime acceptance

Cloud Agents run builds, type checks, isolated Postgres and relevant browser/runtime acceptance on their own cloud Linux environment. Do not use the developer's Mac. v0 Preview is no longer an acceptance path. Run provider authentication and paid infrastructure checks only when separately authorized; distinguish mocks, local integration, deployed acceptance and checks never run.

## Freeze the version under review

- Each Agent hands off its branch, commit SHA, Linux check commands/results and remaining blockers. Keep the reviewed version fixed.
- When a deployment is separately authorized, include its unique URL. A moving branch alias and the shared production domain are not a frozen acceptance version.
- For Linux database tests, explicitly inject an isolated loopback test URL; never inherit a production database URL. Keep test credentials synthetic. Provider sign-in remains a separate integration gate.
- The stable OAuth callback hub routes authentication back to the originating Preview; it must not switch the code version under review to production or another Agent's Preview.

Reference: [Better Auth OAuth proxy](https://better-auth.com/docs/plugins/oauth-proxy).

## Authentication

- Sign in directly with Google or GitHub OAuth in a top-level browser window. Reuse existing authorized provider/browser sessions. Do not ask the user to enter a Mikka password as a routine acceptance step or as the default response to an OAuth error.
- If the provider itself requires MFA or reauthentication, hand over that specific provider step once. Never request passwords or verification codes in chat, and resume using the resulting session.
- For `account_not_linked`, diagnose the provider identity, existing account and verification state. Preserve account ownership checks. Use an already working authorized OAuth provider for general acceptance; report the conflicting provider as blocked rather than repeatedly sending the user through password login. Passing GitHub does not establish Google acceptance.
- Verify the intended identity and an actual Mikka session after OAuth. For Preview proxy acceptance, prove the round trip from the Preview through `https://app.aspectlylabs.com` and back to the originating Preview.
- Exercise authenticated sign-out on the supported Preview URL, including its Vercel branch alias. Unrelated origins must remain rejected.

Record the deployed commit, Preview origin, provider, result and remaining blockers without credential values. Secret storage, successful sync, CI and deployment readiness are separate from runtime acceptance.
