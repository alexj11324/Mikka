# One address for what is on screen; every object opens in one place

- Date: 2026-11-01
- Source: Alex, after the navigation audit (artifact 「Mikka 导航审计」, relayed
  by the coordinating session): 「整个网页的设计里面，路径和跳转是有问题的…
  严查页面跳转的问题：到底哪个路径应该在哪里，页面应该怎么样去跳转。」 On the
  audit's four questions: 「那你就按照建议的来」.
- Rule: R-82 (new), R-66 (desktop half rewritten)
- Replaces: decisions.md 2026-10-25 「clicking it opens the thread conversation
  in the centre, ‹ Coordinator goes back」; R-66's 「on desktop the centre
  column switches to it」

## What the audit found

On `main` at 40c2d30, only a task had an address and a working back. Choosing
a bot, a group chat or a rail page replaced the history entry, so back after
「主页 → 看板」 or after opening a thread left Mikka. Threads, Artifacts,
projects and group chats had no address. One thread opened in three places:
its chat card and the right panel's rows replaced the chat, a task page's row
opened it in the right column, and the inline chip opened its task. On a phone
the board, 建议, Artifact and 插件 pages had no way back, and the right panel had
no button.

## Decided

1. **A thread opens in the right column, beside what is in the centre.** The
   chat (or the task page) stays. This holds for the thread card, the inline
   chip, the sources list, the right panel's 线程 and 全部线程, a task's 线程
   and every notification. On a phone it is a page pushed over the chat, as
   R-66 already said.
2. **A task clicked in chat opens as its own page in the centre**, as Linear
   does. Back returns to the chat as it was, the open thread included.
3. **A thread of another bot**, from 全部线程, opens beside the current chat;
   the chat does not switch. The thread's header names the bot that
   dispatched it.
4. **Projects and teams belong under 看板.** The rail gets no item for them.

And, from the audit's principles, with no conflict to decide:

- One address says what is on screen (centre, right column, window over it),
  so a reload or a pasted link opens the same view.
- A move the person makes is a new history entry; a filter or a tab replaces
  it. Back and forward step one move at a time.
- `components/workspace/workspace-navigation.ts` is the only place that
  writes the address; `scripts/navigation-policy.mjs` fails CI on any other
  history write, `router.push` inside the window, or hand-built `?issue=` /
  `?bot=` / `?section=` link.

## Precedent

Slack opens a thread in a right-hand pane beside the channel, and the thread
is in the URL. Notion's side peek and Claude's Artifacts open beside the page
or chat. Linear opens an issue as a full page and back returns to the list.
Every one of them pushes a side pane in full screen on a phone.

## Order of work

PR 1 (this file): the address module, back and forward for sections, bots and
tasks, the CI guard, R-82. Then the thread column (`thread=`), addresses for
Artifacts, group chats, projects and teams (`artifact=`, `group=`,
`section=agent&session=`, `section=projects&project=`, `team=` for a team's
主页 and `section=team-issues|team-projects&team=`), the task page's origin and
notifications, and the phone web's ways in and out, each with browser tests
for its rows of R-82.
