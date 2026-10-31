# Operations follow-up — 2026-10-31 05:08 UTC

## #214: current upstream and gate result

Read-only registry/advisory checks still find no compatible upstream fix:

- `@anthropic-ai/sandbox-runtime` latest is 0.0.81, integrity
  `sha512-bjHDu87gjIR7+Oxy9jPiK3v8CvSELCzfpXa3fjqfSKdvlZET2iF51xcXILWPayTpowB3xtZeQVf2JR916nVW/w==`.
  Both 0.0.80 and 0.0.81 declare zod `^3.25.0`; published Zod 3 latest remains
  3.25.76. The upstream 0.0.81 tag is
  `c40cf14a65d025e3cd27f071f13a73c12b3b1f92` and still imports `zod/v3`.
- GHSA-mrhx-c7xc-m3w5 / CVE-2023-54404 is high, published vulnerable range
  `<4.6.6`, first patched version 4.6.6. The referenced fix commit
  `a0ebf970f2d752e5f58527cd2942ff48be4f46bd` changes v4 implementation/tests.
  A tiny check of installed 4.6.7's **v3 compatibility subpath** still returned
  11/101 validation issues for 10/100 invalid array elements with max(1).
  No large-input or denial-of-service test was performed.
- Mikka's run launcher and worker actually call the package's
  `NetworkConfigSchema` / `SandboxRuntimeConfigSchema.parse`. This is a used
  dependency. That does not establish an unbounded remote attack: ordinary
  network policy domains have a 200-entry bound and the upstream decider has
  a 1 MiB frame bound. No remotely exploitable Mikka DoS or RCE is claimed.
- GitHub main `a703b0ef` and integration `7870de3c` both still lock the affected
  edge `sandbox-runtime@0.0.80 → zod@3.25.76`. Integration 7870 merges main
  a703 into the follow-up; it is not proof that the follow-up is on main.

A fresh `npm audit` on the **retained, previously built** daemon candidate's
real npm shrinkwrap returned exit 1, high 2 / critical 0: Zod advisory 1243066
and its derived sandbox-runtime finding. The unchanged integration release
policy also returned exit 1 and `allowed:false`. The shrinkwrap SHA-256 is
`e448d694ad61a89e62d1c290898599c4871db61d17d10f944da0ca7d5b00cd3f`.
This is fresh advisory/gate evidence for that retained dependency graph, not a
new build or release acceptance for current main. Logs:
`/tmp/mikka-214-current-daemon-audit.json`,
`/tmp/mikka-214-current-gate.json`, and
`/tmp/mikka-214-current-zod-proof.json`.

No dependency, lockfile, scanner, exception or publishing setting was changed.
A nominal upgrade to 0.0.81 or Zod 4's v3 subpath is not a demonstrated fix.
A compatible upstream v3 remediation or upstream schema migration remains the
specific dependency blocker. No external upstream issue/message was sent.

## #211/#212: original nonproduction completion boundary

Both original issues explicitly allow authorized **nonproduction** acceptance;
#212 explicitly allows an internal alert sink. Production PITR, a new KMS/key
store, cross-region resources, production cutover or external paging are not
additional closure gates. Existing isolated PostgreSQL, the retained private
backup evidence and a loopback receiver suffice for the applicable local work.
Do not treat these extra production capabilities as required unfinished work.

The fixed f0be restore report remains valid for its recorded source: two real
Mikka-schema database dumps, object hashes, current deletion replay, tenant
preservation and credential/approval invalidation, local RPO 1,482 ms and
restore-command RTO 3,377 ms, with eight refused failure cases. The observer
has real SQL/HTTP collection, durable firing/recovery state, authorization and
receiver-failure tests. The existing minute worker now includes
`/api/cron/ops-monitor`; lack of an external sink does not disable collection.

Two concrete evidence/control gaps are corrected by this follow-up:

1. Backup/restore failures now emit a safe event and offer an explicit trusted
   internal delivery adapter. Failed delivery is visible and never masks the
   original failure or authorizes exposure. A real loopback HTTP test checks
   delivered/503/not-configured states, fixed reason codes and privacy, without
   creating a database or container.
2. The next full drill must repair its own injected DB faults and re-query
   `databaseSignals` before reporting recovery. The earlier empty-alert-list
   recovery is no longer used. Only this fixture's never-invoked operation may
   be marked definitively failed; a real uncertain effect requires actual
   provider evidence and is not cleared or resent by this code.

The new full restore drill is **not rerun** in the disk-constrained session;
its new positive recovery measurement remains unexecuted. The original report
retains its original identity and is not relabeled. Source/HTTP tests passed;
no new production, browser, OAuth or paid-resource action was performed.

The whole original issues are still not fully established by the available
component evidence: #211 explicitly asks for an actual fixed Mikka HTTP/tool
business chain supplying the backed-up task/run/approval/file/receipt, while
this drill seeds controlled business rows through SQL. #212 still needs the
same-version actual key-flow baseline, provider 429/unknown and secret-cleanup
failure matrix, and a recorded alert→diagnosis→authorized repair→fresh
observation cycle. These are remaining original **nonproduction** tests, not
requests for a new production monitoring or disaster-recovery platform.
Record those items as unexecuted; do not close a whole issue by renaming its
completed implementation/component scope as full system acceptance.
