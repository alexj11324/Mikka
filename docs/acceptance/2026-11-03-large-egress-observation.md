# Large-result egress observation

## Problem and scope

The production branch still accounted for 98.3% of project transfer in the
15:00–16:00 UTC partial provider bucket. The retired full task query no longer
advanced. A 1% random query sample cannot rule out infrequent large results.
This patch closes that measurement gap; it does not claim a reduction in billed
transfer or identify the remaining source yet. Risk: occurrence 3 × impact 3 = 9.

While the existing diagnostic gate is enabled, every result at least 64 KiB as
JSON is logged with inclusion probability 1. Smaller results retain probability
0.01. The existing collector weights each observation by its own probability,
so large results are not multiplied by 100. SQL text, arguments, records and
message bodies are never logged. The gate-off path does not inspect results.

Enabled diagnostics now serialize every successful result to determine size;
this adds CPU/allocation cost while the incident gate is on. These JSON sizes
are application result estimates, separate from provider billing, PostgreSQL
protocol bytes, and HTTP response bytes. Failed queries remain failures rather
than observations of zero bytes.

## Verification

- Regression test against the original random-only implementation failed with
  zero observations instead of one for an unsampled large result. Restoring the
  patch passed all 11 query-sampler/collector tests.
- Repository lint and typecheck passed.
- CLI acceptance used the real isolated PostgreSQL container on loopback port
  55432. Promise and callback query forms captured a synthetic large result;
  the log contained no synthetic private values. Production was not written.
- Actual isolated PostgreSQL socket measurements (unencrypted local transport):

| Read | PostgreSQL socket bytes | JSON result bytes |
| --- | ---: | ---: |
| One boolean column, one row | 77 | 21 |
| 22 text columns, zero rows | 633 | 2 |
| Synthetic large text, one row | 139,338 | 139,280 |

Empty/small JSON results therefore do not imply zero/small protocol overhead.
These measurements exclude SSL/startup and are not a production billing model.

## Investigation limits

A broader two-snapshot production query-counter comparison included all 1,002
application query IDs, rather than only the minute observer's top cumulative
queries. Over 27.647 seconds it recorded 661 calls and 348 returned/affected
rows. No active full run-chunk history query was identified in that interval.
Other-database high-call statements were internal `cloud_admin` monitoring.
At the later read, application statements mentioning `pg_stat_statements`
totalled 77 calls / 2,443 rows across 26 normalized templates since reset;
this does not establish diagnostic tools as the main source of transfer.

Aggregate-only checks found maximum stored text lengths of 100 bytes for user
images, 1,632 for device harness JSON, 5,659 for run prompts, 30,073 for reports,
and 152,404 for coordinator messages. Values were not returned. The large
coordinator-message maximum supports improving capture, but does not prove
that those messages caused the billed traffic. Continue minute SQL/request
comparisons and provider bucket polling after deployment; missing observations
must not be reported as zero transfer.
