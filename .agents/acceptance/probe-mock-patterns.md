# Probe and fake patterns

Use these examples to choose the boundary that preserves the real behavior
under test. Append a demonstrated pattern with its source and limitations;
do not copy another layer's proof without a distinct contract.

| Boundary | Keep real | Replace or control | Proof limitation |
| --- | --- | --- | --- |
| Model work | Gateway admission, LiteLLM protocol, event parsing, tool dispatch, usage writes | Scripted response at the LiteLLM HTTP boundary | Does not prove a live provider, model quality, subscription, or production mapping. |
| E2B lifecycle | Product code and official SDK serialization, lifecycle/error handling | E2B HTTP API and stream responses | Does not prove provider provisioning or a real cloud VM. Keep device-runtime proof separate. |
| Slack and GitHub | Product handler, SDK/HTTP serialization, durable effect | Loopback HTTP responses and webhook payloads | Does not prove app installation, external permissions, or delivery by the real provider. |
| Device execution | Real daemon, enrollment, dispatch, filesystem/process result, persisted readback | Only outbound provider boundaries needed by the case | A scripted process without the daemon cannot establish device dispatch. |
| Official UI | Production public/private renderer and the affected component | Named fixture state, deterministic IDs/time, model stream replay | Proves the captured scenario and viewport; does not replace API/DB acceptance. |
| PR admission | Checker CLI and HTTP transport, current PR metadata parsing | GitHub HTTP server in unit tests | Loopback tests prove the protocol; a separate authorized test PR proves GitHub status/label effects. |

Sources: [#2884](https://github.com/alexj11324/Mikka/issues/2884),
[#2886](https://github.com/alexj11324/Mikka/issues/2886),
[#2887](https://github.com/alexj11324/Mikka/issues/2887), and
[#2888](https://github.com/alexj11324/Mikka/issues/2888).

## Independent observations

For writes, observe the normal API's acknowledgement and the owning persistent
readback. Do not inject the expected stored row and call that write acceptance.
For refusals, check both the rejection and the independently observed preserved
state. For routing, distinguish a registered route's authorized response from
an upstream 404 or a failed application startup.

When a case declares a capture, trace, or persisted effect in
`requiredEvidence`, its absence produces `uncertain`. Keep the actual reason;
do not weaken an assertion, increase a timeout, or replace the denied path
with a friendlier fake to turn the result green.
