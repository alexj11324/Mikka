# Unfilled binding map

| Operation / field | Meaning and future source | Current value |
|---|---|---|
| Prepare original 13 fields | Exact unchanged `prepare/pins.unfilled.json`; root's fresh A/R7/clock review | All null |
| Prepare `HELPER_PARENT` / `HELPER_PARENT_TREE` | A / A tree, also equal to EXPECTED_APP_SOURCE / TREE | Null |
| Prepare `BRANCH` / helper `__BRANCH__` | `ops/1505-smoke-github-readonly-20261109` at future binding; original pin file remains unfilled | Null |
| Prepare `CLOSED_CARRIER_PARENT` | `prepare/carrier.unfilled.json.closedCarrierCommit`; exact independently verified closed carrier C | Null |
| Prepare operator parents | Exactly `[A, C]`, in that order; C differs from A | Unbound |
| Prepare relative tree delta | Exactly three original added `100644` paths: workflow, helper, original Bot receipt | Fixed contract, no operator created |
| Cleanup original 12 dynamic fields | Exact unchanged `cleanup/bindings.unfilled.json`; fresh APP, actual scope provenance, finite clock and existing GO | All null |
| Cleanup `baseCommit` / `currentMainCommit` | Fresh cleanup A; equal, with matching tree pins | Null |
| Cleanup `CLOSED_CARRIER_PARENT` | `cleanup/carrier.unfilled.json.closedCarrierCommit`; independently re-read latest closed carrier C, possibly after prepare closure | Null |
| Cleanup operator parents | Exactly `[A, C]`, in that order; C differs from A | Unbound |
| Cleanup relative tree delta | Exactly two original added `100644` paths: cleanup workflow and unchanged original helper | Fixed contract, no operator created |
| Cleanup scope pins | Exact actual ID/value SHA256/expiry from the preserved creation receipt; not inferred from APP or C | Null |
| Cleanup `freshScopeReceiptSha256` | Root-reviewed source anchor, not a workflow artifact-download check | Null |
| Root ref update | Normal expected-head FF from freshly verified C; no force and no update performed here | Not performed |

The branch name is an existing carrier selection, not a new identity or OIDC trust rule. The 13 original prepare pins stay intact; the additional ancestry pin is separate. Both `.yml.in` jobs remain disabled; original GO values are unchanged and are not populated in the input JSON files.
