# A usable Linux desktop on the Bot computer

- Date: 2026-11-01
- Source: Alex, in the cloud computer chat: “怎么只有Chrom, Linux的桌面呢？”
- Rule: —
- Replaces: —

The Bot computer needs a usable Linux desktop alongside Chromium. The
implementation keeps Openbox and adds a taskbar with file manager and terminal
launchers, desktop icons, and ordinary window controls. Tint2, PCManFM and XTerm
are the implementation choice; Alex did not request a particular desktop package.

Install the packages in the E2B template, with no package installation on desktop
startup. Desktop preferences stay in the existing per-display profile. The
authenticated viewer, control lease, Unix VNC sockets and Chromium profile
boundaries stay intact. Existing sandboxes need the packages before they gain
these desktop features.
