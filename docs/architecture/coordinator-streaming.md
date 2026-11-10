# Progressive bot replies

The Coordinator and personal bots use the durable Workflow tool loop with
`WorkflowAgent.stream()`. The selected hosted or subscription model retains
its admission, usage accounting and zero SDK retries. A run's writable stays
open between inbox rounds and closes when the workflow finishes.

The workflow writes a turn marker before generation, then model output, then a
commit marker after the final messages pass the credential guard and are saved.
The commit marker carries the actual stored message cursor, since a person can
submit another message while generation is running.

## Authenticated stream

`GET /api/coordinator/stream` authenticates the reader and resolves the active
Workflow lease for that owner and bot. A supplied `runId` checks that the client
and server still refer to the same run. When a message is queued before a turn
starts, `wait=1` waits on the existing PostgreSQL lease notification and returns
the selected run in `x-mikka-stream-run`. An absent or changed active run returns
HTTP 204.

The route sends sequenced JSON-line events for assistant text, masked reasoning,
thinking state, and tool activity with bounded masked input/output previews and
closed error codes. Complete tool inputs and outputs, provider metadata and raw
errors remain server-side. The credential guard holds the last
`longest saved secret length - 1` characters to detect a secret split between
chunks. Quiet handoff sentinels stay hidden. These projections are defined in
[stream-response.ts](../../lib/coordinator/stream-response.ts).

## Rendering and reconnection

The chat supplies accumulated output and streaming state to OpenUI's `Renderer`.
Ordinary Markdown also renders incrementally. An unfinished OpenUI prefix stays
hidden until its component can be recognized. Completed messages come from the
history projection. A host-written turn ID lets persisted history replace the
live reply even when a notification delays the commit marker. The marker is
removed from model history and cannot be supplied by an incoming message.

A reconnect sends the last acknowledged event sequence as `after` with
`x-mikka-stream-key`. The key binds the run, credential fingerprints and
projection version. The server reconstructs masking state from the durable
stream, then skips already acknowledged projected events. A changed key resets
the client to a full replay. A page refresh also discovers the active lease.
Switching bots or leaving the page cancels the reader.

The chat uses `useLiveKey('bot_chat', ...)` for committed message and turn
changes, with a lease deadline and the live layer's disconnected fallback.
Stream completion also revalidates history. The client validates contiguous
sequences and replaces the matching live turns. See
[the stream hook](../../components/coordinator/use-coordinator-stream.ts) and
[chat integration](../../components/coordinator/coordinator-chat.tsx).

## Verification

`pnpm test:coordinator-stream` covers incremental rendering, replay and resume,
bot isolation, replacement by one persisted reply, model-step resets, masked
reasoning and tool previews, cross-chunk credential rejection, authentication,
reader cancellation and stopped-turn consistency. Run it in the environment
specified by [the acceptance guide](../acceptance.md).

Projection timing records first raw text, first emitted text and commit time
for that HTTP projection, including replay. Those values have a separate clock
from provider generation and send-to-first-visible-text measurements.
