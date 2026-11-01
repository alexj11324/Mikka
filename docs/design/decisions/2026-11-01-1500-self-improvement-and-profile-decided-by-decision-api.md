# Self-improvement proposals and the nightly profile merge are decided by the Decision API

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: judgments are made by the Decision API, not hardcoded rules. When to propose a Skill improvement, and the nightly profile merge (purchases into an interest, routine or place; fading stale facts; which answer a slot keeps), are judgments.
- Rule: —
- Replaces: the fixed proposal trigger of 25 distinct failures or a 7-day-old failure (`docs/design/self-improvement.md`, scorer `run-feedback` version 1); the fixed merge thresholds in `docs/design/proactive.md` § 2.2 (3 purchases, 2 places, ⅔ of orders within an hour, 80% weekdays, ×0.95 a night, expire below 0.2, newest answer wins a slot)

**Self-improvement.** `propose` reads a bucket's eligible failures under its
locks and commits, then asks the Decision API one predicate, `propose`, with
the count of distinct failed runs, the oldest and newest failure ages, the
failure reasons, short untrusted report summaries and the time since the last
proposal. A yes (probability ≥ 0.5) re-reads under the same locks and creates
the proposal as before. A no is `decision_not_ready`; no answer is
`decision_unavailable`; neither writes anything, and the next call asks again.
One rule stays code, a runaway cap: at most one new proposal per bucket per 24
hours (`proposal_cap`, no Decision API call). The scorer is now
`run-feedback` version 2, so buckets start fresh.

**Profile merge.** Code still groups candidates (two or more purchases on a
topic or from a merchant, two or more places in an area, facts unseen for 30
days, a slot with several answers) and asks the Decision API per candidate,
up to 40 questions per call and three calls per person a night: a pattern is
an interest, routine (on weekdays or any day) or place, or none; a stale fact
is kept, lowered (×0.95) or expired; a slot keeps the answer it picks. Two
rules stay code: a deadline or renewal is void once its date passes, and a
fact the person corrected wins its slot and never fades. No answer changes
nothing for that item that night; it is asked again the next night.

Model calls never run inside a database transaction or lock.
