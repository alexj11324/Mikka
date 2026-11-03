# Official E2B templates stay unchanged

Alex explicitly requires unmodified E2B templates and no deletion of template
contents. Use new instances of E2B's official `desktop`, `claude` and `codex`
templates rather than Mikka-derived templates. Existing templates and their
definitions remain retained; do not update or delete them.

Mikka's worker, its required Node runtime and extra dependencies may be added
in a separate Mikka-owned directory on an instance. Do not overwrite or remove
the official template's CLI packages, Node/npm installation or system files.
Retain complete official installation packages and their relative directory
layout. Existing incomplete Mikka installations are retained when replaced.

Pause the historical derived-template publishing workflow. A replacement
release validates instance bootstrap and the real CLI capabilities against
official templates, then publishes only the application configuration.
Acceptance compares the official CLI files before and after bootstrap and
runs the real subscription prompt, dispatch, Agent, independent checks and
owner acceptance. Starting a model alone is insufficient.

This supersedes the derived-template publication part of
2026-11-01-1201-e2b-template-public-auto-release and its runtime packaging;
the separate official machine kinds and owner-bound credentials remain.
Implementation and evidence: #1131, #1124.
