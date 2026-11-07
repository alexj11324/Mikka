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

Use the existing `production-evidence-query-templates.json` unchanged. Collect
every discovered trace and all pages, with one fixed UTC window and actual IDs.
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
      traces: { '<actual 32-char trace hex>': traceTables }
    },
    after: { capturedAt: '<later UTC timestamp>', lookup: lookupTableAfter,
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
  // Lookup has ids: manifest.ids instead of traceId.
  columns: ['started_utc', /* exact query column names */],
  pages: [{ offset: 0, returnedRows: 27, truncated: false,
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

`lookup` is `lookup_trace_by_ids` on Logs. Aggregates have one result page at
offset 0. Paginated queries have offsets 0, 500, 1000, etc.; all nonfinal pages
must have exactly 500 rows and the final page must have fewer than 500. An exact
500-row result requires a real subsequent empty page. `returnedRows` records the
captured response count; `truncated:false` must reflect an actually complete
response, never an inference from zero rows or a CLI exit.

The saved MCP response example in
`evidence/posthog-pagination-schema-191fcce2.json` has JSON inside
`content[].text`, then a pipe-formatted `results` string; nullable cells render
as `(null)`. It is **not typed JSON rows**. The executor must normalize those
known metadata columns, preserving types and checking row/column counts before
writing the manifest. This script deliberately does not guess types, repair
truncated text, split potentially ambiguous payloads, or run queries. Keep the
original response receipts separately; this local manifest cannot attest to
the provenance of a caller-supplied value.

## Checked relationships and remaining limits

- Every lookup trace must be supplied. Lookup's ID-bearing span count may be
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
  trace/span; safe body shape remains true. No raw body is emitted.
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
