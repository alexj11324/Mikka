# v3 offline evidence and independent review

verification.md is the original Markdown document supplied by Group, preserved with Git blob **838ef46df925c1bc27df2396e8dca99a998804c9**. It is Markdown, not JSON; its bytes were not converted or reformatted.

The review is bound to product commit **7a4ab4d1fadfc58ac4b759f08e4c41a9a0647c00** and final test-only correction **431b986cb29743c4f10c844d5da8b646daeacefe**, tree **875e232fac0dc52ed22dacd30e17c5babc84e76e**. Independent Factory-continuity review found no remaining blocker after the correction.

The original review found a concrete test defect: an assertion inside the mocked invoke callback could be caught and converted into the GroupJudgmentPendingError expected by an archived failure case. The final child collects actual request digests and compares the array after the route outcome boundary. The recorded mutation check demonstrates old false-pass → corrected failure, followed by restoration of the authentic hash and 57 scoped passing source tests. No bad hash was committed.

The reviewer separately read the archived original JSON from core41778455749 and preflight41785533094 and matched all **36 cases / 63 expected hashes** in the test. This is offline request-byte compatibility with archived receipts, not 63 new provider calls. The reviewer did not rerun models or the author's suites.

Product boundaries checked: live remains v1; only v3's optional-responder question changes; v2 retains its own primary behavior and normal replay API support; v0/v1/v2 historical prompts and receipt versions remain readable. The fixed dataset and labels, 12-case denominator, uncertain and collection checks, nullable cost accounting, four-call routing limit and three-responder limit are unchanged. The future normal acceptance driver expects live v3, so it is not a substitute for staged v3 quality evaluation while live is v1.

The supplied evidence reports 57 source tests and 2 isolated PostgreSQL tests passed with zero skips, plus type/lint/diff checks. This evidence does **not** claim that the new real v3 quality comparison has passed or that v3 has been promoted. Earlier real failed reports retain their failed status. No model request, flag update, deployment or provider action was performed to archive this document.
