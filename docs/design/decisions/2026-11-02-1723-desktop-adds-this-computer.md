# Installing the desktop app makes this computer a device

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator: 装了桌面 App 就应该自动把 daemon 装到这台电脑上，并在系统里登记成设备，不需要用户去点「添加这台电脑」
- Rule: —
- Replaces: the 添加这台电脑 button of usability C10 (#1025)

When the signed-in desktop app starts and this computer is not one of the
person's devices, or its daemon is not running, the app sets it up in the
background: install the Mikka client, start its service as a laptop, sign it
in with a token from the app's session (on stdin), and wait until it is online.
A daemon that does not answer is restarted first and installed only if that
fails, so an existing device is not registered twice. It runs once per launch,
shows no dialog, and appears on 设置 › 设备 as 正在添加这台电脑, 这台电脑已上线,
or 无法添加这台电脑 with the reason and 重试. Nothing happens when this computer
is already the person's device and online.

添加设备 is for other computers: SSH first, which installs, signs in and starts
the daemon; 手动连接 last, the terminal commands for a computer without SSH.
重新连接 on this computer's offline row restarts its daemon.
