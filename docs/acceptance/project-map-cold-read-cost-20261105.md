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
| Total for this observed cookie path | 14 | Expected 8; requires the linked PostgreSQL CI result and production readback |

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

The linked CI must run `test:project-decisions-db`, including:

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

At implementation handoff, local source checks passed; the actual database
measurements above remain pending the linked CI. This executor cannot start
native PostgreSQL under its UID-0-only mapping. No database was started and
no cloud database was allocated for that failed setup. The PR receipt must
attach CI's measured before/after values and the final deployment readback
before describing the cost target as achieved.
