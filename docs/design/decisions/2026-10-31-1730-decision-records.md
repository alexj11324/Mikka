# One file per decision

- Date: 2026-10-31
- Source: Alex, 2026-10-31: 「可以，你开个小PR做吧」, after the question of why every merge conflicted in `decisions.md`
- Rule: —
- Replaces: the single `decisions.md` table with newest rows inserted at the top

Every pull request added its row at the same spot at the top of the
`decisions.md` table, so each merge left every other open pull request with a
conflict and a fresh CI run. New decisions are now one file each in
`docs/design/decisions/`, named `YYYY-MM-DD-HHMM-short-slug.md` (UTC), as in
the usual architecture decision record practice. The existing `decisions.md` is
frozen history and stays authoritative; nothing in it was rewritten.
