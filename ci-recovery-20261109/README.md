# CI recovery attempt and corrected job evidence

This snapshot preserves the eleven frozen local files for operator run `42677288279`, attempt `1`, job `129361977659`. The run failed. Its all-target preflight found that the explicit attempt-1 E2B jobs API already contained a real test job. The recovery receipt therefore has `targets: []` and the outcome records `postCount: 0`: no recovery POST was made.

## Correction to the earlier interpretation

The earlier default jobs endpoint's empty responses remain historical observations. They are not proof that the entire target group had zero jobs. The explicit attempt API evidence supersedes that interpretation. `outcome.json` retains the full source identities, latest five attempt-job responses, actual test log context and the public correction associated with comment `6748520334`. The failure gate remains unresolved in this snapshot; neither the operator failure nor a separately successful job is complete CI success.

The Ops entry was normally closed at `195c681d414e958ad43fbd7222872aa13ca0ef05`; closure run `42677399617` skipped. Original active/closed workflow bytes are archived as inert evidence in this directory, not installed under a workflow-triggering path. New formal startup samples remain zero.

## Fidelity and scope

All eleven supplied files, including the 372938-byte operator log, 45037-byte E2B test log, original 413-byte ZIP and exact receipt/outcome JSON, are preserved unchanged. `readback-transfer.json` is explicitly excluded as temporary transfer material if present. This archive adds only this README and `manifest.json` to the frozen inputs.

The sibling Desktop APT package is a separate optional offline disabled draft. Its 21 passing offline tests are not guest/runtime measurements and do not create a new R7 prerequisite. No test, CI recovery, production, account, VM, SDK or log/artifact download was performed by this archival operation. Root owns final independent comparison and CAS.
