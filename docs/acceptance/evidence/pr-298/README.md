# PR 298 production SSR evidence

Source: `9a85d15b6cbe03a1d5fb5bccc676eb1b7c64377d`.
Deployment: `dpl_geXduXGatJmS1cnR2swFVgQ9ozdN`, existing Mikka production alias.

The original WEBM is an unedited real cloud-browser recording of anonymous navigation to `/mikka`, `/mikka/sign-in`, and `/mikka/en/sign-in`. Each returned HTTP 200. The MP4 is a format conversion of the same complete recording, not a reconstruction or edited success-only clip. The screenshot shows the recovered sign-in page. No account, password, session token, private workspace, or internal log appears in these media.

This evidence proves anonymous rendering recovered from the observed SSR 500. It does not prove sign-in, OAuth, BYOS/provider execution, or credential cleanup. The unauthenticated cleanup endpoint still returns 401 as expected; the separate Infisical authentication failure was not retested.

`receipt.json` records UTC steps, expected/actual statuses, deployment and source SHA, and the original recording hash. The deployment used a one-time `MIGRATE=0 pnpm build` override; logs explicitly recorded migration skipped. No production SQL, permanent project configuration, identity, or scheduler changes were made.
