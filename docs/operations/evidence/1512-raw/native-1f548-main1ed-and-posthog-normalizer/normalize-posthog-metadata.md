# Offline PostHog metadata normalization

This tool parses one saved MCP response from one of the 13 SQL templates in
`production-evidence-query-templates.json`. It performs no network requests,
SQL execution, model work, or PostHog mutation. It is a preparation tool and
does not make a production acceptance decision.

## Run

Use ordinary Node with no installation:

```sh
node normalize-posthog-metadata.mjs \
  --query span_timeline \
  --input saved-raw-mcp-response.json \
  --output normalized-page.json
```

The input is the **raw MCP result JSON**, with `content`, `structuredContent`,
and `isError`. Do not pass the enclosing five-query evidence receipt, a copied
Markdown table, or a manually reconstructed result. Output uses exclusive
creation and mode `0600`; an existing file is never overwritten. Success emits
only query name and row/column counts. Failure exits 2 and prints a closed code,
without the input, a parser cause, a file path, or a stack.

If the original `execute-sql` request was also saved, add
`--request saved-request.json`. Its SQL must exactly equal the response SQL;
only `query`, `truncate`, and optional `context` are accepted. Context is never
copied into output. A request for another connection is refused.

For an already archived multi-query receipt, use the function directly:

```js
import { readFileSync } from 'node:fs'
import { normalizePosthogMetadata } from './normalize-posthog-metadata.mjs'

const saved = JSON.parse(readFileSync(
  './evidence/posthog-pagination-schema-191fcce2.json', 'utf8'))
const entry = saved.queries.find(query => query.name === 'span_timeline')
const normalized = normalizePosthogMetadata(
  entry.name, JSON.stringify(entry.raw_response))
```

In this example, `rawResponseInputSha256` hashes the explicit JSON serialization
passed to the function. The evidence receipt separately records the original
multi-query file's exact byte hash. `contentTextSha256` and
`formattedResultsSha256` hash the captured strings themselves.

## What is accepted

Each SQL text must match its existing template exactly after bounded parameter
substitution. The 13 reviewed SQL hashes are pinned. Parameter repetitions must
agree, UTC dates must be valid, and paginated offsets must be nonnegative
multiples of 500. No SQL is rewritten or executed. A template edit requires
reviewing its projection and updating the normalizer deliberately.

Headers come from the actual response and must exactly match the reviewed
projection, including order and physical UUID columns. The tool does not fill
in missing columns or substitute an expected header. It checks the offline
reconciler's required-column subset too. The response's formatted override must
be byte-identical to its results string.

The supported table representation is the observed unescaped pipe format:
one header, then zero or more full rows, without a trailing blank line. A cell
with an embedded pipe or newline is ambiguous and is refused. JSON envelope
duplicate keys, extra payload fields, invalid UTF-8, missing/truncated syntax,
column-count changes and recognizable truncation markers are refused.

- `(null)` becomes `null` only for a nullable SQL column. Empty string remains
  empty string only where the projection permits it. `(empty)` is never null,
  zero, an empty array, or evidence that the query returned zero rows.
- Numeric fields use finite, bounded numbers. Unsafe integer ranges, negative
  zero, underflow to zero, malformed numbers and empty numeric cells fail.
- Boolean expression cells accept `true`/`false` as booleans or `0`/`1` as
  numbers, preserving that spelling's type. `_raw` flag columns remain strings;
  their `"false"`, `"0"`, and null values are distinct.
- Array cells must be JSON arrays of the declared safe metadata element type.
  Order, empty arrays and UUID bytes are preserved. Python-style arrays,
  nested objects/arrays, and ambiguous placeholder forms fail.
- Strings are restricted to bounded metadata shapes. Raw bodies, prompts,
  response payloads, URL/credential/email shapes and arbitrary extra columns
  are not an accepted input surface. Log bodies are already projected to
  `completed`, `failed`, or `unexpected_body_redacted` by the saved SQL.

Limits are 8 MiB per JSON input, 2 MiB formatted table, 500 rows, 8 KiB per
cell, 500 array elements and 12 JSON nesting levels. Exceeding a bound fails;
the normalizer never cuts off data to fit it.

## Completeness and cluster boundaries

Every output page has **`truncated: null`** and
`truncationSource: not_reported_by_response`. The current official
`execute-sql` input contract describes `truncate:false` for large blob/JSON
**cell values**. It does not provide a response schema or a row-completeness
guarantee. The five saved responses contain no response-level truncation flag,
server total, or original request `truncate` field. The optional request flag
is therefore recorded separately and cannot turn a page into `truncated:false`.
The checked contract is saved in
`evidence/posthog-normalizer-contract-readonly.json`; related official MCP
documentation is at <https://posthog.com/docs/data-warehouse/surfaces/mcp>.

`returnedRows` counts parsed complete lines, not a server-declared total.
`offset` comes from the exact executed SQL. A short or empty page, valid JSON,
or a matching formatted override alone does not prove the full response was
returned. The existing reconciler's `page_truncated_or_unknown` gate remains
unchanged, so feeding these pages into it cannot yield a false completeness pass.

The `cluster` field records the reviewed query contract: AI events/replay use
Default; spans/logs use Logs. The response does not attest its physical cluster.
The tool performs no cross-cluster join and labels this provenance explicitly.
Column types likewise come from the pinned SQL, not server type metadata.

A later collector can establish enumeration against a stable, exact scope by
retrieving consecutive 500-row pages, retaining original physical UUIDs,
checking page boundaries and duplicates, and reconciling all detail counts and
bidirectional identity sets with independent aggregate counts before and after
collection. It must cover every discovered trace and each operation/model/harness
bucket. Agreement is evidence about those retrieved sets and count snapshots;
it is not a promise that the MCP formatter can never truncate. A typed transport
with explicit completion metadata, or a separately reviewed bounded encoding
with independent counts/end markers, can supply stronger transport evidence.
This tool does not implement that policy or override the existing gate.

Native exporter flush remains unconfirmed when its receipt says so. Claude
still lacks an independent count of every upstream subcall. Matching AI/APM
rows cannot remove those boundaries, validate billing accuracy, or prove Replay,
scout, retention or privacy acceptance.

## Offline verification

```sh
node --test normalize-posthog-metadata.test.mjs reconcile-production-evidence.test.mjs
```

The five saved real responses validate parsing of 0/27/0/0/0 rows and their
actual headers, nulls, zeroes, empty parent stage and UUIDs. Their nonempty data
is only the historical span timeline. Arrays and boolean rendering, and the
other eight query result shapes, are covered with synthetic fixtures; they
have not been newly verified against live responses. Header-only schema
preflights are never called production evidence.
