# Publication-kind consumer regression archive

This directory preserves the frozen local regression evidence and the root's later integration/PR evidence as distinct sources. The original agent `README.md` and `manifest.json` remain byte-identical and describe the agent's local stage; their historical inactive/uncommitted scope is not rewritten to imply later execution.

## Included originals

The original manifest lists 47 files; together with that manifest they form 48 original files. `root-binding.json` is already one of those listed files and is preserved once, including all three complete source texts. Root's `root-result.json` and `e2b-ci-steps.json` add two distinct files. Thus this archive contains 50 distinct original files plus this `ARCHIVE-README.md` and `archive-manifest.json`.

`candidate/node_modules` is a local dependency symlink and is explicitly excluded. The archiver neither follows nor copies its target. Candidate/original source, exact patch, original validation commands and RED/GREEN output bytes are preserved.

## Validation and later root evidence

The supplied single-file validation records baseline 24 passed/1 failed, guard RED 27 passed/2 failed, and GREEN 29 passed/0 failed. These are existing local runs, not tests re-executed by the archiver. Root's independent result binds the normal PR head `a83b2a0fbd0b8f45f2e59ce7ceda2f1e06d21055`, parent `cb2f771eeac0c8793e9f94b485dd87c7d5866b4c`, tree `99833a63d69f6b88c64b7c44b44df06d1a0506c5`, to the one-line Node publication guard, its tests and the ADR update. The recorded Python matcher/policy is unchanged.

The saved current-head E2B PR metadata is run `42678667376`, attempt `1`: `test` succeeded and the other six jobs skipped under their original conditions. This is not a production R7 execution, a real subscription acceptance, or a complete-current-head-CI claim. New formal startup samples remain zero.

## Archive-only actions

Only local frozen bytes were copied. No original CI log or artifact was downloaded again, no test or workflow was run, no account/production/VM operation was performed, and no ref was created or moved. The evidence successor has one parent and only this new subtree; root owns the independent comparison and final CAS.
