# Exact 89 runtime subscription failure: cleanup and source investigation

This evidence preserves the failed release, not a successful runtime or a formal startup sample.

- Application source: `89eae89e9e79422e0a8b4b1346aa1c7fb6470016`.
- Runtime run: `42579094044/1`; subscriptions failed, publish skipped, cleanup succeeded.
- Root #1505 was the sole assigned reader of cleanup job `129043491976`. The original 29,286-byte decoded log is preserved unchanged; its one-read boundary is recorded in the metadata.
- The actual cleanup receipt deletes all three candidate templates, with no owned sandboxes remaining and no cleanup errors.
- The subscription job log and artifact were read by the #1503 owner. Root read only the linked public handoff. The owner's two download tool calls and one successful ZIP-content read must not be rewritten as a single global download.
- Claude Code's real subscription execution passed. Codex had successful execution/tool evidence but failed the required reply proof. Runtime MCP evidence/adoption does not replace that proof.
- The source review is fixed to the exact application Git object. It rejects speculative terminal/report ordering explanations and lists the closed predicates still required.
- The PostHog investigation is stored separately under `../runtime89-codex-trace-20261109/`. It did not read model text; candidate identity still needs the original run-ID binding at this checkpoint.
- The source-only Vercel development VM contained no production credentials and made no code changes or model calls. It was stopped and its stopped state was read back.
- No fresh formal startup sample, official-file modification, release publication, or acceptance success is claimed here.

The six historical formal FAIL samples remain unchanged. The next production diagnosis is limited to the existing failed run and must not relax the tool/reply criteria or rerun the model as a substitute for finding the cause.
