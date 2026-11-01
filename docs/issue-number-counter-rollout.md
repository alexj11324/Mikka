# Issue number counter rollout (#499 A12)

The expand migration adds `user.lastIssueNumber`, backfills unnumbered historical issues and seeds each owner's counter from their maximum existing number. A generated `issues.number` mirrors the existing JSON metadata, so readers and old app versions keep using the current document format.

A temporary trigger advances the counter when an old allocator inserts or renumbers an issue. New allocators use an atomic update of the same owner row. This allows both app versions to coexist without allocating the same number; rolling back a failed creation rolls back the counter update too.

The allocator now reserves one number with an atomic `UPDATE … RETURNING` on the owner's counter in the same transaction as creation. Ordinary creates no longer scan or lock existing issues. Page-load backfill examines only unnumbered rows, and reading a fully numbered owner's issues does not consume numbers.

The following standalone concurrent migration adds the unique index `(userId, number)`. Existing numbers are preserved: duplicates make the index build fail rather than silently renumber tasks. The migration runner handles an invalid index left by an interrupted concurrent build before retrying. Fixtures must likewise use distinct numbers within each owner.

Both migrations precede application deployment. They retain the old JSON representation and compatibility trigger, so an old version and the new allocator can coexist and a rollback can restore the old app. After all old versions are out of service, a separate contract migration can remove the compatibility trigger; dropping it in this release would break the rolling-upgrade guarantee.
