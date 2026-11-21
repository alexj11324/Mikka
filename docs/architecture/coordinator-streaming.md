# Bot conversations with eve

The Coordinator and personal Bots use the pinned `eve` agent service in
`apps/eve`. Eve owns the model/tool loop, queued messages, session lifecycle,
stream replay and cancellation. The selected Mikka model still owns admission,
subscription access, billing and provider usage accounting. There is one agent
loop; the former `WorkflowAgent` loop and `/api/coordinator/stream` protocol have
been removed.

## Sessions and streaming

Web and mobile clients use eve's public `useEveAgent` hook and client APIs through
`/mikka/api/agents/eve/v1/*`. The server authenticates the caller, resolves the
Bot and Workspace, and checks the persisted `eve_sessions` binding. Conversation
addresses include owner, Workspace, Bot and channel surface. Slack uses eve's
native Slack channel and a separate surface from private web conversations.

Eve provides its native resumable stream, protocol headers and cancellation.
The application derives live text and tool activity from eve entries, then uses
the existing OpenUI renderer. Changing Bots cancels the previous reader. The
Node proxy preserves streaming bodies, query parameters, cookies and request
cancellation; Vercel mounts the same compiled service under the same public
prefix. Workflow callbacks and durable storage remain separate from the main
application's product workflows. See [deployment](../operations/eve-runtime.md).

## Product authority and history

Eve calls the authenticated internal product gateway for business tools. The
Mikka host executes those tools in its own Workflow world, preserving Factory,
E2B, task machines, native CLI lifecycle and their existing authorization gates.
Enterprise tool authority requires a signed internal service scope and the
current persisted session and execution binding; model-supplied identifiers do
not grant authority.

Mikka supplies product policy, personal instructions and enabled memory. Eve
owns conversation history, pruning and compaction. Product history tables remain
for existing chat display, citations, stored reasoning, task events and retries.
Stored reasoning still passes credential masking and saved-secret checks before
it is displayed. Scheduling remains a Mikka business service: its durable timer
and occurrence authority execute in the product host, then deliver to eve. This
follows the upstream self-hosted pattern of app-managed schedules rather than
adding another generic agent queue or scheduler.

## Retired infrastructure and compatibility

The custom stream projector, decoder, stream state, scoped writable, stop hooks,
turn-holder waiter, hosted startup/round/finish wrappers, generic compaction
model and interrupted-lease recovery are removed from production source.
Historical SQL fixture mutators and the startup-receipt codec live only in
`tests/support/legacy-coordinator-store.ts` and
`tests/support/legacy-coordinator-startup.ts`. They verify migration/history
compatibility and are not imported by production code. Historical receipt rows
remain in the schema; no new runtime uses that engine.

The legacy native Coordinator device endpoint, native-store, tool scope and wake
token remain to reject or settle messages from installed older devices. Their
legacy native coordinator switch stays disabled; the unused native turn relay
has been removed. These modules are distinct from active native CLI task runners,
Factory workflows and task machine lifecycle, which remain product services.

## Verification

`pnpm test:coordinator-stream` covers the native eve client boundaries and
`pnpm test:api` covers the public proxy, cancellation and packaged service.
Product-context tests verify personal settings and memory without reading old
conversation history. Enterprise authority tests cover signature checks,
session/execution revocation, callback lifetime and expiry. Real provider and
subscription acceptance follows [the acceptance guide](../acceptance.md).
