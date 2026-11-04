# Fixed Decision replay comparison, version 2

This comparison contract was reviewed before the next paid replay. It does not
change the fixed baseline, dataset, case order, expected labels, or live routing
behavior. It does not retry an unsuccessful observation or switch providers.

## Demonstrated defect

Production run 41778455749, source 62bb445860642cb110b37e00794daf06ab454f88,
collected all 24 fixed logical observations. Four baseline judgments and two
candidate judgments explicitly returned uncertain with genuine provider
receipts. The previous accuracy denominator excluded those failures:
baseline 5/8 and candidate 10/10 instead of 5/12 and 10/12. Requiring every
baseline judgment to succeed also prevented comparison against these observed
defects in the fixed baseline.

The original run remains failed. Its report is immutable and must not be
rewritten or reclassified as a successful acceptance. Occurrence 9/10,
impact 7/10: the failure exclusion is deterministic for every receipted
abstention and overstates the candidate's measured correctness.

## Independent gates

1. Evidence collection must contain exactly the fixed 12 cases under each
   policy, once each, with bounded ordered provider steps, unique receipts,
   binding checks and retained costs. Authentication, deployment drift,
   missing receipts, transport errors and malformed decisions prevent a
   comparable baseline. Unknown costs remain unknown; they are never zeroed.
2. The fixed baseline may contain a fully receipted, explicit uncertain
   response. It remains an invalid decision with no route or projection.
   It is counted as an abstention and a failed case, never ignore, observe,
   a true negative, or successful silence. A positive case without a usable
   judgment counts as a missed intervention; unresolved negative cases are
   reported separately.
3. The candidate must produce all 12 complete, correctly bound judgments
   and match every curated action, responder and report-timing expectation.
   Candidate uncertainty, unavailable or malformed results, missing evidence,
   incorrect expectations, and intervention regressions still reject review.

Action and responder accuracy use the fixed 12-case denominator. Observed
coverage, complete-judgment coverage, abstentions, unresolved positive/negative
cases, intentional non-intervention and missing case IDs remain visible.
False-intervention counts describe observed complete decisions and must be
read alongside unresolved negative cases; zero false interventions alone is
not proof of correct silence.

An accepted comparison is explicitly comparison_ready under
group-decision-comparison-v2. The number of complete judgments can remain
below 24 because baseline abstentions are preserved. Collection completeness
and candidate correctness remain separate. This is evidence for human policy
review; it does not claim actual wakes, public replies, task completion,
provider billing totals or production acceptance.

The live rollout still requires the authorized group, Factory execution,
independent review/verification, ownership checks and rollback acceptance.
