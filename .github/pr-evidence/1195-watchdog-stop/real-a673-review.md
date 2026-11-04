# Real single-item watchdog acceptance — passed with bounded checkpoint block

This is the completed isolated Flash/native local-loop item 10, not a production
fault injection, Cloud-to-device acceptance, successful resumed execution, or a
before/after performance benchmark. Earlier failed runs remain separate evidence.

## Immutable invocation

- App source: `55840a4f186c86b5c776629a8d075d654dd5c16f`; tree `e2f4733a52611b4b9fb19476d9ab8f7eeb64bc44`.
- Source parent: `59ecb8cde452b2688a4b22a8c01b6baa40710fce`.
- TEMP dispatch: `02824f390d411e95a20be55c4dc4ce6dda20fd83`, branch `acceptance/watchdog-stop-1195`.
- GitHub workflow [41777015753](https://github.com/alexj11324/Mikka/actions/runs/41777015753):
  completed, success; unique Sandbox command `cmd_bb50816f7e284657845b0dea846a`, exit 0.
- Fresh driver run `a673713c-4421-48ee-8713-8530bbc73a4a`; fresh isolated database
  `mikka_loop_a673713c4421_e2e`; selected and passed items both **10 only**.
- The beginning/end source fingerprints are identical:
  `db6638d72e02f78100c673f1cdb690f4f9ed92aab488baf497a5e52ce3ee15da`.
  Tracked source was still clean after exit.
- The five watchdog product files are byte-identical to the reviewed #1195 source
  `020b3957e8fc9609528c69499609adef08150cdf` and later main
  `7b6c1ee1b4a53563b2d6d9885ad992858514cd7a`; exact Git blobs are in the scope file.
  The candidate's only change from its own parent is the acceptance observer's
  one bounded retry for SQLSTATE 57014 and its contract tests. **This run observed
  zero such timeouts and did not need that retry.**

## Actual chain and timing

| Event | Observed result |
|---|---|
| Factory Task | `ddb1d247-fcdb-47e0-ae3d-89dc6e01cd4a` |
| Current request epoch | `4dc82748-43f0-4646-8178-bf922dc3a087`, unchanged through recovery |
| Original A run | `9435e482-0518-4131-ac08-b973c0ef6daf` |
| Recovery B run | `ceaea2b6-8290-4534-a401-9ba14e673a82`, `retryOf=A` |
| Last checkpoint / progress | 2026-11-04T05:07:32.172Z |
| Native-only suspension | 2026-11-04T05:07:33.967Z, four owned processes, shared process group, positive PID signals only |
| Natural server stop request | 2026-11-04T05:53:00.324Z |
| Detection from last progress | 2728146 ms = 45 min 28.146 s |
| Actual daemon acknowledgement | 2026-11-04T05:53:03.407Z, 3083 ms after stop |
| A final classification | `failed / device_lost`, actual local cancellation `SIGTERM` |
| B admitted | 2026-11-04T05:53:03.527310Z, after A's acknowledgement |
| B result | `stopped / blocked`, `checkpointRecoveryUnavailable`; `startedAt=null`, no B model execution |
| Final item result | 2026-11-04T05:56:08.200Z, `passed / bounded_checkpoint_block` |

All 45 observation samples retained the same progress/checkpoint and no new
tool output. A's normal daemon heartbeat and lease remained live: maximum
observed heartbeat age 16903 ms and minimum remaining lease
73105 ms. The independent ordinary minute cron triggered
the stop. No private sweeper, SQL timestamp mutation, shortened product window or
manual stop substituted for that evidence.

The isolated daemon used its existing explicit `--stall-minutes 60` option so
the server's unchanged **45-minute** watchdog could be measured. Its ordinary
default remains **10 minutes**. The recovery snapshot window remains **30 minutes**;
B's rejection therefore is the correct controlled boundary, not a successful
snapshot resume. The public owner Thread reported: “Checkpoint is older than the thirty-minute recovery window.”

The host handoff digest was `25fabcadaeda2258f62f377fad6a3faa0871fdd425477997e08de21a01cbfdb3`.
After another 125 seconds of ordinary cron observation, counts remained:
one retry, zero published effects, one durable notification event, one delivery
and one Coordinator inbox packet. We do not equate notification packets to a fixed
number of model-generated chat bubbles.

## Cleanup and remaining local state

At 05:57:54Z the unique wrapper was gone, all owned daemon/native/Next/driver
processes were gone, ports 3114 and 3191 were closed, and all four A/B
`device.json` / `daemon.secret` files were absent. The two owned Next telemetry
helpers left after normal shutdown were identified by UID, PID/start time,
parentage and exact checkout, terminated with positive-PID SIGTERM, and reread
as absent. No unrelated process or source was modified.

A subsequent read-only database check found two device-token rows, **zero
unrevoked rows**. The normal test-account lease was released at
2026-11-04T05:56:15.225169+00:00; its recorded state is **quarantined**, and it was
expired at observation time. This report does not claim that account is ready
for reuse and does not clear the quarantine. The isolated database and evidence
remain available; no fabricated SQL terminal state or lease update was used.

## Evidence

- `real-a673-item10.json`: complete final driver report and all 45 samples.
- `real-a673-source.json`, `real-a673-passed-items.json`: actual completed source/selection manifests.
- `real-a673-dispatch.json`: wrapper's own final passed result.
- `real-a673-pg.json`: additional read-only Task/epoch and actual A/B terminal rows.
- `real-a673-cleanup.json`: observed process, port, credential-file, revocation and lease state.
- `real-a673-scope.json`: immutable pins, exact command, environment boundaries and product blob equivalence.
- `real-a673-manifest.json`: byte lengths, SHA-256 and Git blob identities of the files above.

The local record contains synthetic acceptance data and safe identifiers. No
credential, private prompt, browser session or raw native session value is
published. GitHub evidence storage does not convert this isolated result into a
production or mixed Cloud/local acceptance.
