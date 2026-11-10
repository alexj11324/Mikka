# Bound Bot-sidebar work titles and stored short titles

- Date: 2026-11-10
- Source: Alex, circling expanded Bot children in the new UI: 「标题必须限制字数，现在没有小模型专门去生成这个标题的吗？」. He then required the restriction in the database. The agreed limit follows the existing task-short-title target: 12 CJK characters or 6 words, at most 60 characters.
- Rule: R-01; the short-title contract.
- Replaces: the approximate limit in [2026-11-06-1400](2026-11-06-1400-task-short-titles.md), the sidebar's direct full-title/prompt label, and storing a long manually typed title verbatim as its derived short title in [2026-11-10-1213](2026-11-10-1213-new-task-optional-title.md).

The Bot sidebar uses the existing task `shortTitle`, which the background
small-model job writes after task creation commits. It no longer ignores
that field. The title part of a child label is at most 12 Unicode characters
when it contains CJK, otherwise 6 words and 60 characters. A task's code is
separate. Mixed text follows the CJK limit; character counting uses Unicode
code points, preserving surrogate pairs.

Generated answers obey the same strict limit, without the former extra
four-character/two-word allowance. The database enforces the derived-title
contract; `NULL` remains valid while no short title is available. A migration
may clear invalid derived title/cache-source pairs, preserving full titles
and task content. Migration acceptance must use an isolated database;
production changes follow normal deployment.

During deployment an older writer can still send an overlong derived title.
A database compatibility trigger drops only an invalid derived title and its
source marker to `NULL` before the check runs. The full title and task creation
remain valid. Direct invalid derived writes therefore clear the cache rather
than aborting the whole task transaction; the check still forbids invalid
stored values.

Until a generated title exists, the sidebar bounds a deterministic fallback
from the task title or standalone run's first line. This fallback is not
claimed to be model-generated and starts no new model request. Existing
task creation stays asynchronous and keeps its model-admission and failure
behavior. A manually typed full title and the task editor's full title remain
unchanged; only their compact navigation label is shortened.
The child tooltip and task detail retain the full title.
