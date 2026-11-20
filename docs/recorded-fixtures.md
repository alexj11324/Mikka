# Import recorded agent streams

This importer converts an **existing local export** into daemon replay JSONL.
It never starts a model, signs into a CLI, contacts production, or opens a
database. Keep the original export outside the repository: only the sanitized
fixture and its metadata are eligible for review and commit.

The recorded library is currently incomplete. No verifiable Claude Code or
Codex exports were available during #2885. The handwritten fixtures in
`packages/daemon/fixtures/` remain handwritten. Importer unit examples are
artificial parser inputs, not recordings or runtime acceptance evidence.

## Prepare an existing export

Use a JSON object with these fields:

| Field | Required content |
| --- | --- |
| `schemaVersion` | `1` |
| `provenance` | `existing-run-export` |
| `harness` | `claude-code` or `codex` from the actual run |
| `cliVersion` | The CLI version recorded by that run |
| `runDate` | The source run date, `YYYY-MM-DD` |
| `sourceRuntime` | The observed source runtime, `device` or `e2b` |
| `scenario` | `plan`, `question`, `tools`, `long-running`, `crash`, `success-pr`, or `quota` |
| `events` | Ordered adapter events with `t` milliseconds or `createdAt` timestamps |

Each event row contains `event: { type: "chunk", chunk: ... }` or a terminal
`event: { type: "exit", outcome: ..., stopReason: ..., report: ... }`. A stored
run chunk may instead use `{ t, chunk }`. Exactly one exit must be last. Keep
the actual order and relative timing; do not invent a hand-in when a run merely
ends. Only an observed `submitted` exit with an agent-owned report produces a
`submit` JSONL line. Daemon-owned verification and file-change claims do not
belong in an adapter report.

The `success-pr` case also needs an exported server publication record as
`publication: { status: "published", pullRequest: { url, state } }` and a real
`data-publish` chunk with `pushed: true`. The daemon's push record alone does not
prove that the server opened a PR. The importer validates the publication with
the current product schema and retains only its digest in metadata.

An arbitrary native CLI log is not silently guessed to be this format. If a
historical export uses another envelope, add a reviewed reader for that format
and exercise it with the existing export. Do not manufacture missing fields
or label a handwritten scenario as recorded.

## Convert, scan and review

From the repository root, with normal workspace dependencies installed:

```sh
node --import tsx scripts/fixtures/record-agent-stream.mjs --input /tmp/existing-run-export.json --output packages/daemon/fixtures/recorded/claude-code-tools.jsonl
node --import tsx scripts/fixtures/check-fixtures.mjs
pnpm test:recorded-fixtures
```

The importer refuses to overwrite an existing file. It writes a JSONL file and
`<name>.jsonl.metadata.json`, both with mode `0600`. The metadata contains the
harness, CLI version, date, source runtime, covered event types, source digest
and fixture digest. No original file path, run identifier, PR URL or raw
request body is printed in CLI results or errors.

All free text, tool input and output, credentials, email addresses and private
paths become placeholders. Correlated message, question and tool-call IDs get
stable anonymous IDs; tool names and unpublished property names are anonymous
too. A final scan fails on suspected secrets. Review the entire sanitized
diff before committing, including metadata. An automated scan is not a claim
that arbitrary historical formats are already supported.

The checker uses the installed AI SDK chunk schema, production hand-in and
failure schemas, and the daemon's actual JSONL parser. Mikka `data-*` parts have
additional payload checks. Unknown data parts, including unreviewed timing
extensions, fail for review instead of being accepted as arbitrary JSON.
Recorded fixtures may not contain executable `exec`, `write` or `hang` actions;
replaying a tool transcript never executes its recorded command.

`self-verify.jsonl` is an existing adversarial handwritten fixture. It
deliberately forges daemon-owned verification fields. The checker requires the
strict importer to reject it; the existing supervisor test still exercises the
daemon's rejection of those claims. It is not relabeled as a valid recording.

## Complete and recheck the library

Each harness needs all seven scenarios: fourteen genuine source exports in
total. `pnpm test:recorded-fixtures` runs importer tests and the mandatory
`--require-library` gate. An empty or partial library fails with the missing
scenario list. The regular MVP fixture gate includes this command.

Review fixtures whenever `packages/daemon/harness/pins.json`, an adapter, the
AI SDK or a protocol schema changes. Compare the new CLI release's event
contract against the pinned source versions, then rerun schema checks and
both runtime integrations. A compatible older recording keeps its truthful
source version; never edit the metadata to pretend it came from a newer CLI.

`sourceRuntime` describes the historical run. It is not proof of replay.
Metadata deliberately begins with `replayEvidence: []`. Completion of #2885
requires separate host-observed runs through the real device daemon and E2B
worker paths, asserting the actual runtime, fixture digest, terminal outcome
and report. Neither importer tests nor source metadata satisfy those two
end-to-end gates. The current PR remains blocked until genuine source exports
and those runtime results exist.
