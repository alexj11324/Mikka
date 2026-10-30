# Issue number counter rollout (#499 A12)

The expand migration adds `user.lastIssueNumber`, backfills unnumbered historical issues and seeds each owner's counter from their maximum existing number. A generated `issues.number` mirrors the existing JSON metadata, so readers and old app versions keep using the current document format.

A temporary trigger advances the counter when an old allocator inserts or renumbers an issue. New allocators use an atomic update of the same owner row. This allows both app versions to coexist without allocating the same number; rolling back a failed creation rolls back the counter update too.

This first PR keeps the current allocator. After this schema is deployed, the next PR switches allocation to the counter and adds the unique index `(userId, number)`. Fixtures that currently reuse a number for the same owner must use distinct numbers. After the old version is out of service, a separate contract migration can remove the compatibility trigger.
