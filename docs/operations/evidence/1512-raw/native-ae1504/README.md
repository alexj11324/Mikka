# Native ae1504 evidence — checkpoint 14

This checkpoint preserves the five original JSON files byte-for-byte (799,865 bytes), the path/hash index for all 310 extracted original files, two original ZIP artifact/digest/CRC-custody receipts, and the frozen source, arithmetic, diagnostics, package and cleanup evidence. File bytes, SHA-256 and Git blob hashes are listed in `checkpoint14-index.safe.json` at the checkpoint prefix.

## Source and observed result

CI run 42541312185, Native job 128918612760, actual checkout `0041c6ab2a28b562deed9c692d8572ac4736f64e`, tree `8c5c12ea993533403d13e21dc75647bb28022767`; the same tree was published at `ae1504f1bb266ae3f7b6612898f134dd979f5fdd`. The job completed successfully at 2026-11-09T01:03:27Z.

The complete original login window passed: Native 384 = 19 + 13 + 352, Web 402 = 19 + 0 + 383. The first startup pair passed: Native 168, hosted 200. Root and agent recomputations are both included. Original windows, common authentication, PKCE and concurrent primary-API/background traffic were retained. These are this workload's measured relative SQL budgets, not a general latency claim.

## Preserved limits

Query diagnostics remain `incomplete`: all 1,154 measured query ordinals are present exactly once, with 239 unknown contexts and 405 unknown statement structures, no dropped measured rows and no overflow. Zero protocol unknown deltas do not erase these diagnostic unknowns. Normalized statement hashes do not prove identical parameters or redundant work. No global outside-window row reconstruction or zero collector overhead is claimed.

Owner and peer account baselines were false before lifecycle and true after cleanup. Initial owner-baseline false values in lifecycle/parity and the original workspace-name cleanup flags remain unchanged. Package/crypto and cleanup receipts retain their exact evidence; a separate PostgreSQL server-stop receipt was not emitted. This checkpoint establishes no production-model, PostHog-ingestion, Replay or issue-closure acceptance.

## Publication boundary

ZIP contents, all 305 PNGs and the complete job log remain local; only their original custody metadata/hashes and the existing closed necessary log excerpts are included. The screenshots were not visually screened for public release here. The all-310-file hash index does not mean all 310 originals have been archived publicly.

Two raw GitHub commit responses also remain local because author/committer metadata and the signed payload contain email addresses. `commit-metadata.public-projection.safe.json` retains only needed commit/tree/parent facts and original hashes. The original source and review indexes still reference those local files; those references are not a claim that their contents are in this payload. `publication-boundary.safe.json` records screening scope and exclusions without printing matched addresses. Four `daemon.secret` fields in the original JSON are closed file-type labels, not secret-file contents.

No network request, source edit, index mutation, acceptance rerun, paid model or cloud resource was used to prepare this local checkpoint.
