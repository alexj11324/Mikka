# Offline production-evidence reconciliation

This script reads local, normalized metadata only. It makes no network calls and
does not authenticate, generate model work, or change a saved PostHog object.

```sh
node ops1512/reconcile-production-evidence.mjs manifest.json reconciliation.json
```

The output must be a new file; it is created with mode `0600`. Exit 0 means the
provided sets/counts are internally consistent. Exit 1 means evidence is missing,
inconsistent or unstable. Exit 2 means the local input/output could not be read or
written. **None means production acceptance passed.** `overallAcceptance` is
always `null`, and `upstreamCompleteness` is always `not_proven`.

## Minimal input schema

Use `production-evidence-query-templates.json`, including the added
`lookup_trace_count` query. The original 13 query texts remain unchanged. Collect
the independent count, every discovered trace and all pages, with one fixed UTC
window and actual IDs. Save raw requests/responses separately; this tool is offline.
The manifest has two complete snapshots, each completed at a recorded UTC time:

```js
{
  schemaVersion: 1,
  projectId: 670821,
  window: ['2026-11-07 10:00:00', '2026-11-07 10:10:00'], // actual query parameters
  ids: { run_id: '<actual UUID or empty>', thread_id: '', task_id: '' },
  snapshots: {
    before: {
      capturedAt: '<UTC ISO timestamp ending Z>',
      lookup: lookupTable,
      lookupCount: independentLookupCountTable,
      traces: { '<actual 32-char trace hex>': traceTables }
    },
    after: { capturedAt: '<later UTC timestamp>', lookup: lookupTableAfter,
      lookupCount: independentLookupCountTableAfter,
      traces: { '<every discovered trace hex>': traceTablesAfter } }
  }
}
```

At least one ID is required. The three ID fields are present even when empty;
this production driver uses UUIDs. Historical arbitrary telemetry labels are not
accepted as substitutes. Each table has this shape:

```js
{
  cluster: 'Logs',                     // Default for the two events queries
  window: manifest.window,             // actual parameters; no sliding window
  traceId: '<exact trace hex>',         // per-trace tables only
  // Lookup and lookupCount have ids: manifest.ids instead of traceId.
  columns: ['started_utc', /* exact query column names */],
  pages: [{ offset: 0, returnedRows: 27, truncated: null,
    rows: [{ started_utc: '<actual UTC timestamp>', /* typed metadata */ }] }]
}
```

Use the **actual** columns from the response, not a synthesized list which hides
a missing column. Import `REQUIRED_COLUMNS` from the script to see the exact
minimum checked fields. Extra columns are permitted but never echoed. Preserve
all original UUIDs and trace/span IDs. Rows are objects keyed by column name;
`null`, zero, booleans, arrays and numbers remain distinct. Missing properties do
not mean `null`. Counters must be nonnegative safe integers.

Required `traceTables` keys:

| Query | Cluster |
| --- | --- |
| `span_timeline` | Logs |
| `trace_integrity` | Logs |
| `safe_native_logs` | Logs |
| `capture_summary` | Logs |
| `apm_generation_spans` | Logs |
| `native_generation_collection` | Logs |
| `generation_receipts` | Default |
| `ai_capture_summary` | Default |

`lookup` is `lookup_trace_by_ids` on Logs. `lookupCount` is `lookup_trace_count`
on Logs: exactly one row with nonnegative safe-integer `trace_count`, at the
same exact window and IDs. It counts the lookup's grouped trace relation;
it is not the number of captured lookup lines. All aggregates have one result
page at offset 0. Paginated queries have offsets 0, 500, 1000, etc.; all nonfinal pages
must have exactly 500 rows and the final page must have fewer than 500. An exact
500-row result requires a real subsequent empty page. `returnedRows` records the
captured response count. Preserve the actual transport declaration:
the current MCP normalizer always returns `truncated:null`. Do not set it to
`false` based on a short page, independent count, saved `truncate:false` request,
or a CLI exit. That request controls large cell values, not a rowset attestation.
Explicit `true` or a missing/invalid declaration still fails.

The saved MCP response example in
`evidence/posthog-pagination-schema-191fcce2.json` has JSON inside
`content[].text`, then a pipe-formatted `results` string; nullable cells render
as `(null)`. It is **not typed JSON rows**. The executor must normalize those
known metadata columns, preserving types and checking row/column counts before
writing the manifest. This script deliberately does not guess types, repair
truncated text, split potentially ambiguous payloads, or run queries. Keep the
original response receipts separately; this local manifest cannot attest to
the provenance of a caller-supplied value.

## Database enumeration and transport are separate

In each snapshot, read the independent lookup count and all lookup pages, then
all required trace tables; record when that complete read ended. Repeat the full
fixed-window collection and record its later completion time. Every consumed
table's normalized rows, not only its total, must agree between snapshots.
Missing counts, late arrivals, identity substitutions and unstable fields fail.
The new count SQL has only been checked offline and needs its own saved real
response when collecting production evidence.

The output may report `transport.rowsetTruncation: unknown` and
`databaseEnumeration.status: complete` together. The latter means that the
captured, scoped unique identity sets match independent database counts and
stable repeated reads. It does not certify transport completeness, an atomic
database snapshot, future ingestion, upstream delivery or production acceptance.
An explicitly truncated page always keeps the result incomplete.

| Consumed query | Independent completeness check |
| --- | --- |
| `lookup_trace_by_ids` | Unique trace IDs equal the same-scope `lookup_trace_count` aggregate; every discovered trace is supplied. |
| `lookup_trace_count` | Exactly one typed count row, no SQL limit, same IDs/window in both snapshots. |
| `span_timeline` | Raw row count and distinct span count equal `trace_integrity`; original physical UUIDs and logical IDs are unique. |
| `trace_integrity` | Exactly one aggregate row with required typed counts and identity sets. |
| `generation_receipts` | Row count, distinct event UUIDs and span IDs equal the three `ai_capture_summary` totals. |
| `ai_capture_summary` | Exactly one aggregate row; count, usage and timing coverage checked against detail. |
| `apm_generation_spans` | Logical IDs, physical UUIDs and their exact pairing equal the complete timeline's generation subset. |
| `native_generation_collection` | Same identity/pair equality against the complete timeline's collection subset. |
| `safe_native_logs` | Unique original log UUID count equals `capture_summary.native_log_rows`, which uses `uniqExact(uuid)`. Physical duplicate multiplicity is not proven. |
| `capture_summary` | Exactly the three fixed signal rows, with one occurrence of each. |

Four additional normalized queries remain **not evaluated** by this helper:

| Query | What would be needed for a separate evaluation |
| --- | --- |
| `tail_error_retention` | Compare the expected zero/one web group with the full timeline; retention values need their own acceptance check. |
| `source_correlation` | Match unique service/version groups and summed counts to the complete timeline. |
| `apm_session_links` | Match each session/service group, unique count and ID set to the complete timeline. |
| `replay_correlation` | Verify its one literal requested-session row; even row completeness does not establish Replay playback. |

Their presence in a manifest never turns them into verified evidence. The report
lists them in `databaseEnumeration.queriesNotEvaluated`.

## Checked relationships and remaining limits

- Lookup's unique trace count must equal its independent count; every lookup
  trace must be supplied. Lookup's ID-bearing span count may be
  smaller than the full trace, which also contains ancestors.
- Timeline raw rows and logical span counts match integrity; physical UUIDs are
  unique. Generation and collection subsets match in both directions by logical
  ID, physical UUID **and their pairing**, with raw counts separate.
- AI row count, event UUID count and logical span count match all three summary
  counts. AI/APM ID sets, model, parent, operation/harness, present provider,
  run/thread/task/session links and numeric usage/timing agree. Null is not zero.
- The same identities/counts are checked per `(operation, model, harness)`.
  Output identifies a bucket by `sha256(JSON.stringify([operation,model,harness]))`
  and its three null flags, rather than reflecting arbitrary input labels.
  This keeps distinct unknown labels separate and does not omit Decision or
  other non-agent models. Compare the hash to the local input when identifying
  a particular model bucket.
- Log UUID count matches capture summary and logs reference the same actual APM
  trace/span; safe body shape remains true. No raw body is emitted. This proves
  the unique log UUID set only; `logsPhysicalMultiplicity` remains `not_proven`.
- For each Codex run, collection counters are summed once per unique collection
  span. `intendedEmissions = native_generations + fallback_generations` is compared
  to both daemon/APM and AI generation identities. `observedAppServerReceipts =
  matched_fallbacks + fallback_generations` is reported separately, not counted
  again as generated requests. Conflicting duplicate collection receipts make
  totals unknown. Native/fallback timing-basis counts are checked separately.
- Both snapshots' entire normalized rows/counts and identity/session sets must
  agree, with array order ignored but multiplicity retained. Equal totals alone
  cannot hide replaced identities. Any instability requires a new fixed-scope
  evidence read, **not another provider task**.

The output lists missing fields/pages/tables, wrong scope/cluster, duplicates,
truncation and unstable data explicitly. Native missing/invalid/incomplete counts,
unknown timing, fallback timing, unconfirmed CLI exit/flush and Claude's absent
independent upstream-count receipt remain limitations. Equal AI/APM counts cannot
prove an unseen upstream request was captured. A true CLI-exit flag is never a
flush guarantee. Replay playback/correlation, scouts, full stage coverage,
controlled failure provenance, cost accuracy and production privacy acceptance
remain separate checks. Empty data is never positive acceptance evidence.
