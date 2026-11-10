# The official builds lay a private BoardUI layer over the open-source UI

- Date: 2026-11-06
- Source: Alex, 2026-11-06, relayed by the coordinator and in issue #1527: the hosted product (the official web app and the official desktop installers) moves to the paid BoardUI interface, 「我要的就是他们的 UI」, bot avatars included (BoardUI's paper `agent-avatar`). The open-source repository's interface stays as it is.
- Rule: —
- Replaces: —
- Superseded in part by: [2026-11-08-2133 one UI](2026-11-08-2133-one-ui.md). The slot mechanism stays; "the open-source repository's interface stays as it is" and the hosted vs open-source framing no longer apply.

The paid BoardUI code lives only in the private repository
`alexj11324/mikka-hosted-ui`. This repository never imports BoardUI code, and
a pull request without the private layer must pass CI.

This repository marks each screen part the hosted product replaces as a slot
(`@ui-slot/<name>`). Its default implementation is today's component, in
`components/slots/`. An official build sets `MIKKA_UI_OVERLAY_DIR` to a local
checkout of the private repository, and each slot resolves to
`$MIKKA_UI_OVERLAY_DIR/slots/<name>.tsx` instead. Without the variable the
build is the open-source build, unchanged. How the slots resolve is in
[`docs/ui-overlay.md`](../../ui-overlay.md).

A slot only changes how something looks. Data, state and behaviour stay in this
repository and reach the slot as props, so the hosted interface keeps every
feature the open-source one has (streaming, stop, tool calls, attachments,
OpenUI cards and charts, the Artifact entry). The first slot is the bot avatar.
