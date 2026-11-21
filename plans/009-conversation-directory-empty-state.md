# Plan 009: Give the conversation directory a real empty state (R-96)

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result. On any STOP condition, stop and report.
>
> **Drift check (run first)**: `git diff --stat 89f5e7634..HEAD -- components/workspace/conversation-directory.tsx messages/zh-CN.json messages/en.json`
> On a mismatch with the excerpts, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: UX / rules compliance
- **Planned at**: commit `89f5e7634`, 2026-11-19

## Why this matters

The thread directory has four filters (`search`, `state`, `archived`, `pullState`) and exactly **one** empty state, whose copy is `"没有匹配的线程。"` — "no matching threads", i.e. a *filtered* result.

It is also shown when there are genuinely no threads at all, where "no matching" is wrong. And in either case there is **no control that resolves it**: no "clear filters", no "new thread". The user is told there is nothing and given no next step.

`rules.md` is explicit:

> **R-96** Every list state is drawn. "Nothing here" and "nothing matches the filters" are two different states, each with the one action that resolves it (R-41); loading is a skeleton, never a status string.
>
> **R-41** An empty state is one concrete state line plus one button (often "send to a bot"). Never "这里是空的" or "Check back later".

The repo already has the correct shape in `components/workspace/issue-list.tsx:41-49`:
```tsx
<EmptyTitle>{searching ? t('noResults') : t('emptyTitle')}</EmptyTitle>
{!searching && <EmptyContent><Button size="sm" onClick={onCreate}>…{t('newTask')}</Button></EmptyContent>}
{searching && onClearFilters && <EmptyContent><Button size="sm" variant="outline" onClick={onClearFilters}>{t('clearFilters')}</Button></EmptyContent>}
```

## Current state

`components/workspace/conversation-directory.tsx:117-123`:
```tsx
    {data && !rows.length && !more && !error && <Empty className="min-h-64 border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">{pullsOnly ? <GitPullRequest aria-hidden="true" /> : <MessageSquare aria-hidden="true" />}</EmptyMedia>
        <EmptyTitle>{t('empty')}</EmptyTitle>
      </EmptyHeader>
    </Empty>}
```

Filter state lives at `:58-60`:
```ts
  const [search, setSearch] = useState('')
  const [state, setState] = useState<DirectoryState | 'all'>('all')
  const [archived, setArchived] = useState(false)
```

Copy in `messages/zh-CN.json` under `ConversationDirectory`:
- `empty` → `"没有匹配的线程。"`

There is **no** `emptyTitle` / `noResults` / `clearFilters` key in this namespace yet.

`EmptyContent` is exported from `components/ui/empty.tsx` and is currently **not imported** by this file.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| i18n (both locales) | `node scripts/check-i18n.mjs` | `i18n check passed` |
| i18n unit tests | `node --test scripts/check-i18n.test.mjs` | pass |
| Directory tests | `node --import tsx --test components/workspace/conversation-directory-search.test.tsx components/workspace/conversation-directory-archive.test.tsx` | pass |
| UI policy | `node scripts/lint-ui.mjs` | 0 errors |

## Scope

**In scope**:
- `components/workspace/conversation-directory.tsx`
- `messages/zh-CN.json`, `messages/en.json` — new keys in the `ConversationDirectory` namespace
- The two directory test files, to cover the new states

**Out of scope**:
- `components/workspace/pull-directory.tsx` — it already has `noMatches`/`empty` (`:427`). Do not touch it; another session may be editing it.
- The `PullDirectory.empty` copy — different component.
- Any change to filtering logic or the query.

## Steps

### Step 1: Add the copy keys

In `messages/zh-CN.json` under `ConversationDirectory`, add (keep the existing `empty` key — it stays the "nothing matches" line):
```json
    "emptyTitle": "还没有线程。",
    "clearFilters": "清除筛选",
```

In `messages/en.json` under the same namespace:
```json
    "emptyTitle": "No threads yet.",
    "clearFilters": "Clear filters",
```

**Verify**: `node scripts/check-i18n.mjs` passes (it checks key parity and placeholder match).

### Step 2: Distinguish the two states in the component

Replace the block at `:117-123` with:

```tsx
    {data && !rows.length && !more && !error && (() => {
      const filtered = Boolean(query) || state !== 'all' || archived || (!pullsOnly && pullState !== 'all')
      return <Empty className="min-h-64 border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">{pullsOnly ? <GitPullRequest aria-hidden="true" /> : <MessageSquare aria-hidden="true" />}</EmptyMedia>
          <EmptyTitle>{filtered ? t('empty') : t('emptyTitle')}</EmptyTitle>
        </EmptyHeader>
        {filtered && <EmptyContent>
          <Button size="sm" variant="outline" onClick={() => { setSearch(''); setState('all'); setArchived(false); setPullState('all') }}>{t('clearFilters')}</Button>
        </EmptyContent>}
      </Empty>
    })()}
```

Add `EmptyContent` to the existing `@/components/ui/empty` import at the top of the file.

**Verify**: `grep -n "EmptyContent" components/workspace/conversation-directory.tsx` → import + one usage.

> **Note**: check the exact `pullState` setter name and default value at `:60-61` before writing the reset. The filter row already reads `pullState` and `setPullState`; use those names.

### Step 3: Do NOT add a "new thread" button here

R-41 says "one button", and for the unfiltered-empty case the natural action would be creating a thread — but this directory has no create handler and adding one is out of scope. The unfiltered state therefore shows the state line only. Record that in the PR: **the unfiltered empty state has no action because the component has no create path; the rail owns creation.**

**Verify**: by reading — no `onCreate` prop was invented.

### Step 4: Cover both states in the tests

In `components/workspace/conversation-directory-search.test.tsx`, add a case: with a non-matching query and zero rows, the rendered text is the `empty` string and a "clear filters" button exists; clicking it calls the setters (assert the search input's value becomes empty).

In `components/workspace/conversation-directory-archive.test.tsx` (or the search file, whichever has the simpler harness), add: with no filters and zero rows, the rendered text is `emptyTitle` and there is **no** clear-filters button.

**Verify**: both files pass.

### Step 5: Run the gates

```sh
node scripts/check-i18n.mjs
node --test scripts/check-i18n.test.mjs
node --import tsx --test components/workspace/conversation-directory-search.test.tsx components/workspace/conversation-directory-archive.test.tsx
node scripts/lint-ui.mjs
```

**Verify**: all pass; `0 errors`.

## Test plan

- **New**: filtered-empty shows `empty` + a working clear-filters button.
- **New**: unfiltered-empty shows `emptyTitle` and no button.
- **Pattern**: `components/workspace/issue-list.tsx`'s two-state empty.
- **Must not regress**: the archive and search behaviours already covered by those two suites.

## Done criteria

- [ ] Two distinct empty states render for the two conditions
- [ ] The filtered state has a button that resets every filter
- [ ] Both new keys exist in both locales; `pnpm i18n:check` passes
- [ ] Both directory test files pass
- [ ] `node scripts/lint-ui.mjs` reports 0 errors
- [ ] `pull-directory.tsx` untouched

## STOP conditions

Stop and report if:
- `pullState` / `setPullState` do not exist with those names.
- A test asserts the exact previous empty-state markup (update it, but say so).
- The component turns out to be unreachable in the official build (check `grep -rn "ConversationDirectory" components/workspace/issue-workspace.tsx`) — if it is dead in the hosted layer, report before spending effort on copy.

## Maintenance notes

- The reset clears four filters at once. If a fifth filter is added later, the reset must include it — the `filtered` predicate and the reset list must stay in sync. A reviewer should check both.
- Copy follows C-01 (status line, not a sentence) and R-41 (one line + one button).
