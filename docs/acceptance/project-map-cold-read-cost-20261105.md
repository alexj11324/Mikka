# Project map cold-read cost — 2026-11-05

This change addresses the additional cost request in
[#1247, comment 6670840341](https://github.com/alexj11324/Mikka/issues/1247#issuecomment-6670840341).
It reduces database result JSON and sequential SQL calls on a fresh read. It
does not add a cache, a polling loop, or a new public snapshot parameter.

## Observed production baseline

The baseline is one real production request at `2026-11-05T21:57:33.719Z`,
on deployment `dpl_8Fk32K4C5T1qLNLUPrMGMvYp3ZZT`, Git
`8eaf7ea542e27f1c1c1e71e7a04e3da55221b211`. It read a page of the isolated
synthetic 1,000-node fixture: one Project, 100 issues and 899 canceled run
records. These inert records do not prove a live provider execution pipeline.

[PostHog trace 3ABA4905D9A16020E8660C161EF39C5E](https://us.posthog.com/project/670821/tracing?trace=3ABA4905D9A16020E8660C161EF39C5E)
contains HTTP 200, a 415.194 ms request span, 14 PostgreSQL statements,
12 SELECTs, and 353,988 approximate result JSON bytes. The initial metadata
projection accounts for 313,215 bytes. Each of the two workspace scope reads
accounts for 16,077 bytes and each visible-issue read for 4,102 bytes.

| Component | Baseline statements | Change |
| --- | ---: | --- |
| Fresh workspace and issue ACL, before and after content | 4 | Preserve all four; compact the workspace link transport |
| Best-effort live revision | 1 | Preserve |
| Graph snapshot transaction and two metadata batches | 4 | One pure SELECT containing every projection and source authorization |
| Fresh secret masking material | 5 | Two reads, preserving the workspace/app database split |
| Cookie session in this trace | 0 | No authentication changes |
| Total for this observed cookie path | 14 | Eight in the isolated cached-session fixture below; production readback remains pending |

The earlier isolated full-HTTP benchmark used PAT authentication, with
15 statements / 10 SELECTs and no configured secret key. Those numbers are a
different path. PAT verification, its workspace transaction, and user lookup
remain intact. Neither count is a universal claim for every authentication
state, source endpoint or configured secret set.

All byte figures here describe JSON result serialization, not PostgreSQL wire
framing, HTTP transfer bytes or an asserted provider bill. This one trace is
not a latency percentile or a concurrency benchmark.

## Implementation and invariants

`read-sql.ts` places the existing logical projections in one read-only SQL
statement. Every dependent ID set comes from the same statement snapshot.
The source authorization SQL is shared with the source endpoint; its stricter
Bot owner check and available / unavailable / denied states are retained.
The collector no longer needs a separate BEGIN and COMMIT. Both authority
databases are still re-read after collection and masking, with the existing
bounded retry when scope changes.

Only the internal issue/run transport is column-oriented. A constant column
contains one value; varying columns contain one value per row. Empty tables,
SQL nulls and JSON arrays remain distinct. Run issue references use the
request's visible issue UUID array. Timestamp encoding uses a floored epoch
millisecond value, retaining the old JavaScript Date normalization even for
microseconds and dates before 1970. Original timestamp ordering is preserved.
The column names are themselves a jsonb object so decoded row keys retain the
old jsonb row key order before sanitization, masking and fingerprinting.

The 1 MiB allowance still counts the original complete logical row objects,
including decision sources and their authorization results. Compression does
not enlarge that allowance. The original per-table limits, the 100-issue
scope limit, and fail-closed error behavior remain. Every bounded fact is
still read for topology, lane/fold assignment, filters, path, overview and
content-change 409 behavior; there is no premature SQL LIMIT 50.

The map-specific masker keeps current workspace members on the workspace
database. A guarded application-database statement reads the same workspace,
repository, owner, active-member E2B and legacy E2B material. Existing AAD,
credential-pattern masking, category precedence and decryption error policies
remain. Secret material never enters MapFacts or the response. The global
masker and PAT authentication are unchanged.

## Verification and byte reporting

For PR head `2b6ca07cc7b46970f4b693757be70a1ce1448343`,
[CI run 42126423740, database job 4](https://github.com/alexj11324/Mikka/actions/runs/42126423740/job/127591767660)
ran `test:project-decisions-db`: **39 passed, zero failed, canceled or skipped**.
The suite includes:

- The existing owner/peer, revocation, private run, workspace conflict,
  source-locator, paging and snapshot-change cases.
- Real PostgreSQL timestamp inputs with `.123456` microseconds and values on
  both sides of the Unix epoch; decoded JSON and fingerprints equal the
  original jsonb rows.
- Oversized logical projections returning 413 even when columns compress well.
- Representative **100 issues + 399/899 runs + one Project = 500/1,000 nodes** cases.
  The test reports the same statement's uncompressed and compact JSON bytes,
  retains all facts, and compares complete facts and fingerprints. The raw
  form of the new statement isolates the encoding effect; it is not presented
  as an execution of the old multi-query collector.
- The same 500/1,000-node cases through HTTP with a deliberately stubbed cached
  session resolver and real enabled masking reads: an eight-statement budget
  and database JSON ceilings of 80 KiB / 100,000 bytes respectively. Cookie
  parsing is outside this fixture. These are regression limits; production
  results still require readback.
- Existing 500/1,000-**execution** measurements, labeled as 502/1,002 graph
  nodes, through real PAT authorization. They must not be relabeled as the
  production fixture's exact 500/1,000-node layouts.
- Old and new masking paths compared using real encrypted fixtures and real
  PostgreSQL predicates, including suspended members, foreign scopes, legacy
  key ownership and corrupt ciphertext behavior.

The same real PostgreSQL run reported these exact-layout measurements. All
values are bytes; each collector uses one SELECT. The uncompressed and compact
columns run the new single-statement projections against the same facts,
isolating transport encoding rather than claiming a legacy collector run.

| Graph layout | Uncompressed collector JSON | Compact collector JSON | Unchanged logical budget bytes | Complete HTTP DB JSON | Complete HTTP statements / SELECTs |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 issues + 399 runs + root = 500 nodes | 152,324 | 39,075 | 162,843 | 64,604 | 8 / 8 |
| 100 issues + 899 runs + root = 1,000 nodes | 318,824 | 74,025 | 341,343 | 99,554 | 8 / 8 |

The complete HTTP measurements include fresh pre/post workspace and issue
ACL, live revision, all graph facts and two real masking reads. They use the
cached-session resolver stub described above; they exclude cookie parsing,
PostgreSQL wire framing and production network time. Both regression ceilings
passed. The production baseline and this isolated result have different
environments, so their difference is not a measured production improvement.
Deployment-bound production readback is still required.

## Independent CI suite timeout

The full CI run is **not green**: database job 2 hit the existing 120-second
parent deadline in the Factory Profile suite after #1449 added ten sequential
cross-Harness candidate recheck cases. This is separate from the map suite in
database job 4. The observed comparison is:

| Profile suite observation | Main `82789ddf380841a4f3ea637d940005bbbd2cecdd` | PR merge tree `b454194a8cd1d6ecc5c684e6efc09daa4efb1098` |
| --- | ---: | ---: |
| Parent duration | 109,049.686 ms, passed | 120,511.028 ms, parent timed out |
| First 48 child cases | All passed; 89,976.877 ms in total | All passed; 105,676.074 ms in total |
| Ten new recheck cases | 46,395.628 ms in total | 55,391.957 ms in total |
| Whole factory-checks command | 272 passed, zero failed/canceled/skipped | 257 passed, 12 failed, one canceled, zero skipped |

The [main baseline job](https://github.com/alexj11324/Mikka/actions/runs/42126327488/job/127591439120)
and [PR job](https://github.com/alexj11324/Mikka/actions/runs/42126423740/job/127591767632)
show that the PR's first child failure was `Cannot use a pool after calling
end on the pool` after the parent deadline triggered cleanup. All 12 failures
share that error; the final two normal cases were not registered. No earlier
product assertion failed. The follow-up changes only this parent's finite
budget to 180 seconds, retaining every case, assertion, cleanup action, the
15-second statement timeout and the 5-second lock timeout. Its complete CI
result remains required; the failed head is not rerun to obtain a faster runner.
