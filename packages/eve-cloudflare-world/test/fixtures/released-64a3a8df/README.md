# Released Eve caller

These ten source files are unmodified Git blobs from public commit
`64a3a8df554f7efdd00784a3790a544109ade658`. They retain their original relative
paths so `node-world.test.mjs` can execute the released Node client against the
new World Worker and Durable Object through the existing local Miniflare setup.
The fixture runs no model and contacts no external service.

The successful [serving release job](https://github.com/alexj11324/Mikka/actions/runs/44473639414/job/135389683331)
identifies that public source, completed on 2026-11-19 at 06:40:43 UTC.
`release.json` records each source Git blob SHA. This proves the fixture's
published source; it does not claim a fresh production probe.

When retiring this compatibility floor, extract a later **published** caller's
`packages/eve-cloudflare-world/src/node-world.mjs` and its relative imports with
`git show SOURCE_COMMIT:PATH`, preserving their bytes and paths. Record its
serving release evidence. Keep the oldest supported caller until the deployment
owner confirms no service uses it. Do not regenerate the fixture from an
unreleased working tree to make a contract failure pass.
