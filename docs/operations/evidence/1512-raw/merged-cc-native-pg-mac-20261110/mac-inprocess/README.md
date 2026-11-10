# #1512 macOS in-process diagnostic evidence

The original formal macOS Node22 reconnect failure remains unresolved by these diagnostics. This archive records one lower-perturbation diagnostic run, its source/package binding, exact command timing, cleanup, and disabled entry.

## Outcome

Actual run [42745131850/A1](https://github.com/alexj11324/Mikka/actions/runs/42745131850) succeeded on control commit `299fbddd8c8f252959088a8cafabde962636b945`. The installed temporary daemon was formal source `5852aa8832c07fdeef43665dd5e156ce5516e3ea` plus exactly the archived `service.ts` instrumentation overlay. This is diagnostic success, not a product fix, production acceptance, or replacement for the unmodified formal Node22 gate.

| Phase | bootout | bootstrap | Measured command gap |
| --- | --- | --- | --- |
| Install | exit3; 02:52:38.654–38.684Z; 29.765ms | exit0; 02:52:38.684–38.703Z; 19.078ms | 0.003ms |
| Reconnect | exit0; 02:52:41.434–41.455Z; 20.907ms | exit0; 02:52:41.455–41.475Z; 19.531ms | 0.002ms |

The first daemon generation logged started at02:52:39.755Z, registered at39.798Z, and stopped at02:52:41.454Z. A second generation logged started at02:52:42.399Z. These are point-in-time application logs, not independent process-exit or launchd-state probes. Missing lifecycle entries do not prove an event did not happen.

The original formal5852 run failed with bootstrap5. Its daemon stopped log is at00:59:46.745Z; diagnostic JSON began emitting at00:59:46.789209Z. The original log lacks bootout status and launchctl invocation/return timestamps. Error-result emission times cannot establish the original command ordering relative to the stopped event. The prior wrapper diagnostic succeeded with a70ms gap; the present diagnostic succeeded with a0.002ms reconnect gap. Neither supplies a confirmed cause or justifies retry, polling, delay, or a kickstart replacement.

## Cleanup and closure

The fixture-finally receipt reports bootout0, server closed, environment restored, and exact private HOME removed. The controller validated the private owner record, made exactly one cleanup bootout and one print call, and reported private control removal. Those commands returned3 and113 respectively; these nonzero codes do not independently prove service or process absence. The receipt explicitly retains `processAbsence: not_independently_probed`.

A normal compare-and-swap closing commit, `63b020064269cf66c6ee551b451ffd911f9489d2`, disabled both job guards and set the manifest enabled flag false. Remote readback matched. Closing run [42745834949/A1](https://github.com/alexj11324/Mikka/actions/runs/42745834949) and both jobs were skipped with no runner assignment and no steps.

## Evidence navigation

- [result.safe.json](result.safe.json): complete bounded result, source/package binding, cleanup, closure, and activity.
- [timing-comparison.safe.json](timing-comparison.safe.json): original failure and both diagnostics, including interpretation limits.
- [index.safe.json](index.safe.json): every archived payload's Git blob, byte length, SHA256 and origin.
- `originals/`: unchanged MCP responses and exact decoded logs, frozen before parsing. Each job log was read from Actions once by this agent.
- `derived/`: JSON payloads extracted from those logs; these are not separately downloaded artifact members.
- `source/`, `static/`: exact executed temporary sources, preparation checks, and independent review.
- `metadata/`, `closure/`: raw API responses, disabled sources, closure readback and skipped-job evidence.
- `historical/`: already-frozen prior evidence reused by Git blob, without rereading original Actions logs.

Both artifact ZIPs were only listed as metadata and were not downloaded. In particular, the individual Mac source-binding and fixture-cleanup artifact members were not inspected separately; the successful fixed controller binding step and selected fixture-finally fields in the controller cleanup log are the available witnesses. Two original job-log reads, one actual Mac fixture execution, zero workflow reruns, zero extraction VMs, zero owned active extraction VMs, and zero formal branch changes.

Future CI on a materially changed formal head is independent evidence and does not rewrite the historical5852 failure.
