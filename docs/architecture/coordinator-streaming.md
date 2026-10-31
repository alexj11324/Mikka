# Progressive bot replies

The Coordinator and personal bots use the existing durable Workflow tool loop
with `WorkflowAgent.stream()`. The selected hosted or subscription model keeps
its admission, usage accounting and zero SDK retries. A run's writable remains
open between inbox rounds and closes when the workflow finishes.

The workflow writes a turn marker before generation, then model output, then a
commit marker after the final messages pass the existing credential guard and
are saved. The commit marker carries the actual stored message cursor, since a
person can submit another message while generation is running. This uses the
existing database schema.

`GET /api/coordinator/stream` authenticates the reader and resolves the active
Workflow lease for that exact owner and bot. A supplied run ID only checks that
the client and server still refer to the same run. The route publishes text and
turn lifecycle events as JSON lines; model reasoning, tool payloads, provider
metadata and raw errors stay on the server. The existing credential fingerprints
also guard the stream: it holds the last `longest saved secret length - 1`
characters so a secret split between chunks is blocked before transmission.
Quiet handoff sentinels remain hidden.

The chat supplies accumulated output and the real streaming state to OpenUI's
`Renderer`. Ordinary Markdown also renders incrementally. A possible unfinished
OpenUI prefix stays hidden until its component can be recognized. Completed
messages continue to come from the existing history projection. An assistant
row carries a host-written turn ID in its JSON, so history replaces the live
reply even if a notification delays the stream's commit marker. A committed
cursor also reconciles replies across lease changes. The host marker is removed
from model history and cannot be supplied by an incoming message.

History polling discovers active runs and reconnects interrupted readers.
Reconnects replay the durable stream from zero and replace the matching live
turns, so token and UI-chunk cursor domains cannot be confused. A page refresh
discovers the same active lease. Switching bots or leaving the page cancels the
reader; it does not cancel the workflow. Vercel request cancellation is enabled
only for this streaming route.

Acceptance checks that an initial OpenUI paragraph appears while a later model
chunk is withheld and no assistant message has been persisted, then checks
refresh/replay, bot isolation, and replacement by exactly one saved reply.
Source tests cover model-step resets, multi-step output, chunk decoding,
cross-chunk credential rejection, authentication and reader cancellation.
Provider latency and time to first visible text are measured separately from
workflow completion and history polling.

References: [OpenUI Renderer](https://www.openui.com/docs/openui-lang/renderer),
[Workflow streaming](https://workflow-sdk.dev/docs/foundations/streaming),
[WorkflowAgent](https://ai-sdk.dev/v7/docs/agents/workflow-agent).
