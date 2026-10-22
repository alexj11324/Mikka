# Runtime acceptance

Run acceptance on a deployed cloud Preview. Builds and type checks run in remote CI; do not start a local server, database, build or `tsgo` on the developer's Mac.

## Authentication

- Sign in directly with Google or GitHub OAuth in a top-level browser window. Reuse existing authorized provider/browser sessions. Do not ask the user to enter a Mikka password as a routine acceptance step or as the default response to an OAuth error.
- If the provider itself requires MFA or reauthentication, hand over that specific provider step once. Never request passwords or verification codes in chat, and resume using the resulting session.
- For `account_not_linked`, diagnose the provider identity, existing account and verification state. Preserve account ownership checks. Use an already working authorized OAuth provider for general acceptance; report the conflicting provider as blocked rather than repeatedly sending the user through password login. Passing GitHub does not establish Google acceptance.
- Verify the intended identity and an actual Mikka session after OAuth. For Preview proxy acceptance, prove the round trip from the Preview through `https://app.aspectlylabs.com` and back to the originating Preview.
- Exercise authenticated sign-out on the supported Preview URL, including its Vercel branch alias. Unrelated origins must remain rejected.

Record the deployed commit, Preview origin, provider, result and remaining blockers without credential values. Secret storage, successful sync, CI and deployment readiness are separate from runtime acceptance.
