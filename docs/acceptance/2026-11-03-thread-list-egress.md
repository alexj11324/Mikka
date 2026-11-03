# Quiet thread-list polls

Production census samples at 16:22–16:26:30Z on November 3 showed the thread
list returning 119 rows / 70,805 row-JSON bytes per call, four calls / 283,220
bytes total. These samples have sampleRate=1 and are not multiplied by 100.
They identify a repeated full-list transfer, not the whole provider bill.
Occurrence10/10 × impact4/10 =40: open windows repeat the same bounded history.

The server now fingerprints the same owner-filtered, 30-day, 200-row query
inside Postgres and returns only a version when the list is unchanged. Session
authorization still runs every time. The fingerprint includes displayed run,
bot, agent and device data; ordinary device heartbeat timestamps are replaced
by the actual queued-local-device waiting state, so heartbeat ticks do not
invalidate history while online/offline transitions remain visible.

The browser retains its current rows on unchanged responses. The 60-second
refresh interval and explicit refresh actions are preserved. Cache entries are
scoped by user; suggestion/coordinator invalidations match those keys. No copy,
layout, pagination limit or ordering rule changes.

## Isolated regression evidence

A real disposable Postgres fixture with 119 synthetic threads was measured
using socket receive counters. Running the old action twice read 94,444 bytes
on each call and failed the quiet-transfer assertion. Restoring the fix passed:
83,056 bytes on the first snapshot and 106 bytes on a quiet poll. These are
isolated database socket bytes, not JSON estimates or Neon billing totals.

The same test covers ordinary heartbeats, offline waiting, cloud exclusions,
reply updates and ordering, edits without timestamp updates, bot renames,
deletions, authentication and owner isolation. The related activity/document/
task/thread database group passed seven tests. Existing waiting-device
regressions, types, lint, library and thread DOM checks are recorded with the
version-bound production-build/HTTP acceptance below and in the PR.
