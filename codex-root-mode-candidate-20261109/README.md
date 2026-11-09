# Codex root CA mode candidate evidence

This is an offline archival snapshot of the frozen candidate and its already completed validation. The candidate source baseline is `8197a48843f9733a775003898ab00eaceb533c66`. The evidence parent is `45e0fccdb447dd0ae1943dafedfdb55adb4bf72b`.

## Contents and fidelity

- `frozen-candidate/` contains exactly the original manifest's 25 members plus that unchanged manifest: 26 original files. This includes original and candidate source, the actual RED, both GREEN iterations, actual commands and source bindings, and minimal patches.
- `codex-root-mode-root-binding-1505.json` is the root's unchanged source/integration binding.
- `product-evidence/` contains the two unchanged product evidence reports and the separate ADR addendum. The addendum is archived as supplied, not reconstructed from the older main checkout.
- This top-level README and `manifest.json` record archive composition. The original manifest is not edited.

The original local validation selected four new Codex methods and four directly related existing methods. The recorded RED exited 1; both recorded GREEN executions exited 0. The later test comment clarification has its own source identity and GREEN receipt. Archiving did not execute these tests again.

## Evidence boundaries

The official control reproduced Codex's root CA file mode transition from 0644 before/pre-finalization to 0777 at ready/fresh. Desktop control observations remained unchanged; they do not reproduce or attribute the earlier Desktop mutation. Candidate acceptance and control observations do not prove a successful new runtime publication or formal six-case performance acceptance.

This snapshot contains only the supplied frozen evidence. Subsequent GitHub platform-failure metadata and new CI receipts are outside this snapshot and may be archived separately by root. No missing CI state is inferred.

All source bytes are retained exactly. Transient `__pycache__` files are omitted under the original manifest's rule. Git blobs deduplicate repeated original/candidate source bytes. Only an unreferenced single-parent evidence commit is prepared; root owns the final compare and CAS. This archival operation performs no production, account, model, VM, workflow, or ref mutation and no new original-log/artifact download.
