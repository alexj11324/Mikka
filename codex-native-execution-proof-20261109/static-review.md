# Bounded static review of a709

The Codex native-name prepass and main execution pass agree on a successful, finite-ms `agent_start`, the two input chunk types, a nonempty tool call ID of at most 512 characters, SHA256 truncated to 16 hexadecimal characters, and the first 64 distinct input IDs after start. Handoff calls consume the same input slots. The prepass permits a late name for an already admitted call after the cap, and cannot downgrade an identified native tool to an unknown name. The bounded set does not consume pre-start noise.

The new outcome checks apply only to exact Codex `bash` and `apply_patch` names. Shell requires numerical `exitCode === 0`; patch requires the actual protocol `status === 'completed'`. Other harnesses and ordinary MCP calls retain availability semantics. The audit outcome and message wire are unchanged. A failed available result or an explicit error removes that call from the successful-execution set.

One preexisting ordering limitation was reported to root and is outside this patch: A succeeds, a reply marker is observed, B succeeds, then a contradictory later completion revokes A. B remains in the final successful set although B followed the reply; the boolean reply proof remains set. The analogous submitted-report association can also be stale. This is a static synthetic trace, not an observed provider sequence or a reproduction of the historical failure. Whether real Codex produces contradictory duplicate terminal events is unproven. Root explicitly directed recording this boundary without expanding this patch.

This review makes no claim about the cause of earlier submit-only/ended-before-execution-proof runs, late MCP catalogue availability, real model execution, production readiness, or current deployment state.
