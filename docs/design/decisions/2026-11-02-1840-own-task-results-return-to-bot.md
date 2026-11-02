# Return a Bot's own completed task without a second paid-model gate

- Date: 2026-11-02 (America/New_York)
- Source: Alex asked to finish fixing the remaining completion notification failure: 「这个你不修吗？」; earlier requirement: everyone can use their own subscription in any workspace, sharing is separately authorized.
- Implementation: a server-confirmed terminal result for the same owner and original dispatching Bot is request/result transport. It returns to that Bot under the existing visibility and ownership gates, without first requiring a team-funded Decisions call.
- This does not classify arbitrary incoming events, grant approval or publish an Agent's claims as host proof. Canonical run identity/status/finish time and matching issue/stop reason are required. The result payload stays untrusted; the Bot's normal model handles it.
- Existing Decisions classification for other runtime events, optional phone notifications, sharing and paid-model admission remain in effect. No team sharing, payment or production credentials are modified.

Observed defect: a personal-subscription Agent submitted successfully in an eight-member team. The team had no Mikka-default balance, had exhausted its trial and had no shared-credit authorization. Its completion event's extra Gateway classification was refused before inference, retained as `triage_pending` and misleadingly shown as `wake_start_unconfirmed`.

Occurrence 8/10 × impact 7/10 = 56: every such completed personal-subscription task in that team can fail to return its result. Source diagnosis and a real isolated PostgreSQL reproduction precede the fix.

References: https://workflow-sdk.dev/docs/foundations/workflows-and-steps and https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-decisions .
