# Recorded stream fixtures

This directory currently contains **no recorded model sessions**. The existing
JSONL files one directory above are handwritten test scenarios. They must not be
relabeled as recordings.

Issue #2885 needs an existing, locally exported Claude Code or Codex run for each
of `plan`, `question`, `tools`, `long-running`, `crash`, `success-pr`, and `quota`.
The current execution environment and public repository contain no verifiable
source exports for that library. The importer never starts a model, signs in to
a CLI, reads a production database, or contacts a service to obtain one.

Run `node --import tsx scripts/fixtures/check-fixtures.mjs --require-library`
from the repository root. Until the genuine recordings are supplied, this fails
with the complete missing scenario list. An empty directory does not pass the
recorded-library acceptance gate.

The adjacent metadata records the **source** runtime, CLI version, date and
covered events. It intentionally starts with `replayEvidence: []`: importing a
file is not proof of a device or E2B replay. Both runtime paths need independent
host evidence from their actual integration runs before #2885 can be completed.
