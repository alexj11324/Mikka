# #1294 Coordinator wake deadline evidence

Code PR: https://github.com/alexj11324/Mikka/pull/1294

Code head: `9f0529efe6fab31bcda2d0c4e738308a8cd49e58`; code tree: `28f979c9000bb263d42fd3e0e9c24bc2862d928f`; base: `fc2d401bde7b3f567b1288b01accd6fdeb433d0c`.

This independent evidence branch contains no application change beyond its parent code head and is not intended for main. The PR remains draft, with production and the issue body's measurement gates outstanding. The minute sweep remains.

- [Validation and limitations](VALIDATION.md)
- [Independent source review](INDEPENDENT-ROOT-REVIEW.md)
- [Final exact-head CI completion](CI-9f0529e.md)
- [Original RED/GREEN and first runtime failure archive](preintegration.tar.gz)
- [Final integrated gates, successful real timer and cleanup archive](final-export.tar.gz)
- [Archive hashes](archive-manifest.json)
- [GitHub source tree and command/cleanup receipts](publication-receipt.json)

Extract each archive into a directory named after the archive, without `.tar.gz`, to match paths in VALIDATION.md. Both archives retain original unedited logs, including failures. The runtime-proof directory preserves both exact evidence driver versions; these were test-only scripts, not product changes.

The evidence branch changes documentation only. The 22 inherited workflow triggers were checked at the code head; none has a push trigger matching this evidence branch. No workflow or deployment is manually triggered by publishing this evidence.
