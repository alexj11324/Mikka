# Acceptance lessons

Runners and checkers append verified lessons here with their source and the
resulting action. A lesson records an observed failure mode; it does not create
a second product rule or redefine the owning test's assertions.

## 2026-11-20 — S1–S7 integration

Source: [Capy alignment batch #2883](https://github.com/alexj11324/Mikka/pull/2883)
and [workflow adaptation #2889](https://github.com/alexj11324/Mikka/issues/2889).

| Observed integration risk | Action and evidence |
| --- | --- |
| A public slot's props and its private hosted implementation evolve together. | Build the intended public/private SHA pair. A successful public-only compile cannot establish that the hosted slot accepts the same props. Keep private source out of the public diff and artifacts. |
| Generated route files conflict when independent branches add routes. | Merge the source handlers, run `node apps/api/scripts/generate-routes.mjs`, then `node apps/api/scripts/generate-routes.mjs --check`. Preserve every branch's route registration. |
| Combined SQL conditions can reuse a positional parameter for different values. | Inspect each combined query and its value array, renumber positions after merging, and execute the owning PostgreSQL regression. In #2883 the automation filter follows the existing `since` parameter. |
| A last-writer replacement of configuration can discard another branch's keys. | Merge `config/self-hosted-requirements.json` by key and compare the combined diff against main and each source branch. |

## 2026-11-20 — PR declaration is narrower than acceptance

Source: [#2888](https://github.com/alexj11324/Mikka/issues/2888).

The deterministic checker can establish that a declaration names a runtime,
scripted model, revision, fixtures, and evidence. It cannot establish that the
linked screenshot shows the correct official build or that a report proves
the expected behavior. The independent checker verifies those facts. A draft
status and a missing required artifact remain unaccepted.
