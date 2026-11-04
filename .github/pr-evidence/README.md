# Reviewed UI evidence for PRs #1168 and #1170

This evidence-only branch archives eight existing screenshots and their original review records. The screenshots were captured from local production builds with normal authenticated test accounts and synthetic display fixtures. No new UI capture, provider call or model execution was performed for this archive.

The root agent reviewed all eight images before requesting publication. The publishing agent inspected them again: no credentials, private instructions or personal production data are visible. The WebP files contain no EXIF, XMP or ICC metadata. Uploaded image blob hashes match the source files byte for byte.

| PR | UI | Original capture source | Review and images |
| --- | --- | --- | --- |
| #1168 | Execution account usage | `70b210ed4060334546283dc20951ac8b22501ce3` | [Review](1168-identity/review.md) |
| #1170 | Bot public role editor | `e95e90d391d81ef57037a0f3710569fba0ea7031` | [Review](1170-public-role/review.md), [API/layout record](1170-public-role/review.json) |

Each set includes English and Chinese at 390 × 844 and 1440 × 1000. The original review files state the exact build, authentication, API checks and limitations. These are rendering and API evidence for their recorded sources; they do not independently prove production deployment or model-routing execution.

[Image checksums and dimensions](manifest.json) identify the archived files. Use immutable commit URLs when linking this evidence from a PR. This branch is for evidence attachment and is not an application change to merge into main.
