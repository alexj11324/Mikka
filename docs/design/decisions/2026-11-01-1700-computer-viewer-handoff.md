# Computer viewer handoff and click targets

- Date: 2026-11-01
- Source: Alex, current desktop bug report and screenshots, relayed by the coordinator: keep the desktop picture continuous during takeover and handback, remove the orange/yellow perimeter, close from all outer margins, and open the right-panel preview from anywhere inside it.
- Rule: —
- Replaces: viewer border and button-only preview opening in the merged implementation

Alex requested that taking control and handing it back keep the desktop picture
continuous: only the bottom control state and buttons change. Remove the orange
or yellow perimeter around the desktop. Clicking the fullscreen space above,
below, left or right of the desktop closes the viewer; desktop and control clicks
stay inside it. Escape and the accessible exit remain available.

In the bot's right-panel computer preview, the entire desktop opens the enlarged
viewer, including blank areas around the centered 打开 label. This click never
operates the remote desktop. The preview has one keyboard-accessible opening
control, separate from sleeping or failed-machine recovery controls.
