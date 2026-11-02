# Reuse the official E2B desktop

- Date: 2026-11-01
- Source: Alex, cloud computer chat, approving official template reuse: “可以复用”.
- Rule: —
- Replaces: [A usable Linux desktop on the Bot computer](2026-11-01-2236-cloud-linux-desktop.md).

Use E2B's official `desktop` template for the basic Linux desktop and its XFCE
applications. Preserve its desktop defaults instead of assembling an Openbox
desktop, custom launchers, Dock or homepage.

The inspected official `desktop` image has XFCE and applications but no Node,
Codex or Claude Code. The separate official `codex` and `claude` images each have
one coding CLI and no desktop. Extend `desktop` with Mikka's worker, Node and
both verified CLI pins once at image build time. Tasks start with these tools
already installed. See the [official template extension guide](https://github.com/e2b-dev/desktop/blob/main/template/README.md).

Keep the existing per-display profile/session separation, authenticated viewer,
control leases, private Unix VNC sockets and worker credential boundaries.
Removing the inner task sandbox requires a separate decision about moving its
trusted controller and enforcing network access outside the task's control.

The desktop startup script belongs to its immutable image and package set.
Runtime authorization updates may refresh the viewer gateway and lease driver;
they must not replace an old image's desktop startup script.

The recipe can be reused with another E2B instance when that instance provides
the official `desktop` parent template. A saved cloud template ID does not
identify an image on another instance; build the official parent there first.
