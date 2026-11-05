# Production deployment observation: efef5b5a

Related tracking issue: #1210.

This is a read-only deployment observation for the externally merged question-wake recovery PR #1287. It does not attest that the original Owner answered a question or completed a new model run.

- Source/squash SHA: efef5b5a5a8a55deb3c504b05fb736d4003e942c.
- Parent: 3adee90c742b045e0eebd5854eecc6ade1c84aae.
- Web deploy run 41944628493 completed successfully. Saved job metadata records the actual GitHub build, prebuilt upload and public-version verification steps.
- Independent unauthenticated GET at 2026-11-05T01:05:32.104Z returned HTTP 200 and an exact public build match. See version.json.
- E2B official runtime run 41944628574 completed test/check/validate/publish successfully; validate and publish actually ran, rather than being conditional skips. Saved metadata is in runtime-jobs.json.

The old runtime publisher's successful run also exposed the obsolete release path. Job 126975166613 contains this non-sensitive observation:

`2026-11-05T00:57:34.0065797Z redeploy: dpl_FKBXLqPyXYbFNX1Pcu8yfzJwb1xV from dpl_7Qqfnj8E1dg4eeD2MeyCDHAjHtJ9`

It invoked a Vercel source redeploy after changing runtime environment values. That behavior is separate from the normal successful GitHub Web build and does not meet the requested GitHub-only production build flow. A narrowly scoped fix is being prepared to route the verified runtime refresh through Web deploy and remove the source-deployment POST. No old publisher retry, deployment deletion or token revocation was initiated by this observation.

The prior 3ade runtime publish failed with production_source_changed while the corresponding GitHub Web build was still running. The two observations support the same release correction: wait for the exact GitHub build/public version outside the deployment lock, then serialize the runtime environment update and prebuilt build/upload with current-main guards.

Remaining #1210 acceptance still includes the designated original cases and required models. The original API case was already attempted and failed with an unavailable key balance; the original CC Factory case was still waiting for its real Owner as of the last bounded read-only audit. This deployment observation does not replace that audit or its limits.

