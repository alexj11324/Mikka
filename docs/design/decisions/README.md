# Decisions

One file per product or design decision Alex made. This is the usual
architecture-decision-record layout: a new decision is a new file, so parallel
pull requests never edit the same lines.

`../decisions.md` holds every decision made before 2026-10-31 17:30 UTC. It
stays authoritative and is frozen: add nothing new there. To supersede one of
its rows, strike that row (~~like this~~) and link the new file.

## Adding a decision

Name the file `YYYY-MM-DD-HHMM-short-slug.md`, using UTC time, for example
`2026-10-31-1730-decision-records.md`. Sorting the folder by name gives the
order; newest is last. Write it the day you hear it:

```md
# Short title

- Date: 2026-10-31
- Source: who said it and where, with the quote
- Rule: rules.md ids it adds or changes, or —
- Replaces: the older decision file or decisions.md row, or —

What was decided, and what follows from it.
```

To supersede a decision, add the new file and set `Superseded by:` on the old
one. Never delete a decision. Accepted Figma frames are listed in the decision
that accepts them.
