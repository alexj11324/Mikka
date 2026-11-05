# Due-timer migration checkpoint — handoff only

Root chose the narrower peer PR1403 as the authoritative fix. This local branch is preserved for regression transfer and review; it is not a second proposed release and was not pushed.

The concrete additional race is in `election-regression.ts`: a six-hour successor loses a short election to a candidate that yields to the incumbent. Waking the incumbent before releasing that election can strand the successor. The preserved RED is 4/5 and the corrected loop/migration GREEN is 12/12. The correction releases election ownership before nudging and retries a legitimate handoff on real wakes while retaining the global hook. A wake never acknowledges takeover.

`validation.json` keeps each actual source stage distinct. The earlier 70 unit/contract checks and 15 PostgreSQL checks do not stand in for a final whole-tree validation. The last structured diagnostic assertions are intentionally pending after the decision to adopt the peer patch. `db-receipt.json` records zero sessions and normal DROP of only this fixture role/database; no FORCE, terminate or cluster stop.

The source contains no provider or production operation. Cancellation terminal status does not prove an already-running step has ended. Production migration still requires the owner’s normal release/acceptance flow and evidence of the old Workflow’s retirement and lack of later consumption.
