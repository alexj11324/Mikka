# Active conversation delivery

Alex set **queue** as the initial delivery preference for an active conversation in [#2262](https://github.com/alexj11324/Mikka/issues/2262). The owner may change it when the running harness supports another mode.

Queued text remains visible and cancellable until the host claims it. A successful run completion admits the next message through the existing conversation writer. Cancellation, revocation, provider failure, a new question or replacement of the original conversation leaves the queued instruction unexecuted. Already published commits and pull requests stay in the conversation history.

Codex can accept a steer directed at its active turn. Interrupt uses the existing Factory request transition that stops the superseded executor. Claude Code can consume an extra SDK message in either this turn or the next. Cursor ACP enqueues inputs during an active prompt. Only an operation with the corresponding execution contract is shown.

The daemon advertises active-turn steering for its installed Codex adapter. It journals the command ID before contacting the provider and acknowledges acceptance or refusal through the device's existing command channel. A missing acknowledgement leaves the text visible. A refusal or an interrupted RPC stays visible as an unconfirmed delivery and never starts another turn.

Personal Bot chat uses its existing fixed Eve session. Its channel defaults to queue, and its native client also accepts steer from the caller of the active turn. The composer accepts additional drafts during admission and submits them in order. A draft can be withdrawn before its native admission begins. Retries retain the original operation and policy. Eve cancellation targets the active turn; its HTTP protocol exposes no per-delivery withdrawal after admission. Native interaction approvals retain their dedicated answer controls.
