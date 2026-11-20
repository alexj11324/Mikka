# Personal keyboard shortcuts and settings search

P9 of #2956 is the final settings backend workstream, after the P1–P8 implementations. It builds on P1's field guards, typed values, authenticated owner writes, reset and schema metadata. Frontend consumption belongs to #2957.

Each configurable existing action has one stable shared action ID and one personal registry field. The dedicated `keyboard_shortcuts` table uses typed action and binding columns, with no JSON setting blob. Adding an action after this table exists requires a registry declaration, not a new migration or server action.

The server normalizes bindings, rejects conflicts against the full effective set under the existing owner lock, and treats null as reset and an empty binding as explicit disable. Search labels, keywords and page IDs come from the same setting registry. Existing sidebar search remains available.

Implementation, action inventory, migration and validation evidence are in progress. No models or production database use. This PR will enter the merge-commit settings batch only after its own latest-head CI passes.
