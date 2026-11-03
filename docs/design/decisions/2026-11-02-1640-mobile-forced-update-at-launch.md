# The iOS app updates before it opens

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session: 「手机 App 启动时强制更新：用户关掉再打开，如果有新版本，必须先更新才能进入」. The coordinator added offline/timeout entry, the minimum native build and leaving a running app alone; the details follow common practice.
- Rule: —
- Replaces: —

A cold start (`components/StartupGate.tsx`) does two checks before the app opens:

- **OTA update.** It asks expo-updates for a newer update, waiting at most 5 s.
  When there is one, the screen shows 「正在更新」 while it downloads (at most
  20 s), and then the app reopens on the new update. If the device is offline
  or either limit passes, the app opens as it is, and a download still under
  way waits for 重启以更新.
- **Native build.** `GET /api/version` gives `minMobileBuild`
  (`lib/mobile-min-build.ts`). A phone whose native build (CFBundleVersion) is
  older sees 「请更新到最新版」 with 更新, which opens the app in TestFlight, and
  there is no way past it. An unknown build, an unknown minimum or an
  unreachable Mikka lets the person in.

To use the gate, raise `MIN_MOBILE_BUILD` in the pull request that ships a
native change older builds cannot run. While the app is running nothing
changes: the background check and 重启以更新 stay as they were.
