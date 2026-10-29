---
name: roundtable
description: A table of 7 Claudes, each playing a top VC firm (Y Combinator, Sequoia, a16z and more) by that firm's public advice, hears your startup pitch like a real meeting, grills you with hard questions, then every firm votes fund, fund if, or pass, and every firm that passes says exactly what to fix. Use when the user says /roundtable, "pitch my startup", "would VCs fund this", "practice my investor pitch", "mock VC meeting", "pitch deck feedback", or "investor roundtable".
argument-hint: "[--seed N] [--firms 7] [--demo]"
license: MIT
---

# /roundtable

Usage: `/roundtable` (it asks what it needs in one message) · `/roundtable --firms 10` (every firm) · `/roundtable --seed 7`
(the same table again) · `/roundtable --demo` (no questions: use what the user gave in their message and answer the
grilling with only what the pitch and notes already say).

`table.py` sits next to this file. Run it from the folder you started in: `python3 <this folder>/table.py ...`.
Everything goes in `.roundtable/` there.

## The table

Three firms always sit in: **Y Combinator** (wants a small team that ships fast, talks to users every week and can say
what it does in one line), **Sequoia** (wants a clear why now, a big market and a company that could still matter in 20
years), **a16z** (bets on technical founders building software that changes how a whole industry works). The rest are
dealt from: Benchmark, Founders Fund, Accel, Lightspeed, Kleiner Perkins, General Catalyst, Index Ventures. Then
**The Coach** reads every vote.

Each firm is a Claude playing that firm's public advice to founders. It is not the firm and never says it speaks for it.

## The one rule (read to every firm, word for word)

> You only know what is in `.roundtable/case.json`: the founder's goal, their pitch (numbered paragraphs), the facts
> they pasted, and their answers to the grilling once there are some. Judge the pitch the way your firm says in public
> that it judges startups, honestly and as hard as a real partner meeting. Every point you make quotes the founder's
> exact words. Never invent facts about the founder, the company, the market or the numbers. You are a Claude playing
> this firm's public advice, not the firm itself.

## Steps

1. **The pitch.** Unless `--demo`, ask in plain words, in one message: what you are raising and for what, your pitch as
   text with one slide or point per paragraph, and the real facts behind it (users, revenue, team, what you have built).
   Save the pitch to `.roundtable/pitch.txt` and the facts to `.roundtable/about.txt`, then run
   `table.py setup --text .roundtable/pitch.txt --goal "..." --about .roundtable/about.txt [--seed N] [--firms N]`.
   Tell the user who is at the table, in one line.
2. **The grilling.** Spawn one sub-agent per firm in `.roundtable/case.json`, all at the same time. Each gets the rule
   above, its own name and line, and the case. Each writes `.roundtable/questions/<seat>.json`:
   `{"firm": "<seat>", "questions": [{"ask": "the one hard question this firm would ask in the meeting", "quote": "exact words from the pitch it is about"}]}`
   with 2 questions. Then run `table.py grill`. If a firm was thrown out, run just that firm once more with the reason.
3. **Answer.** Show the user `.roundtable/grill.md` and ask them to answer every question in one message, one paragraph
   per answer, in order. With `--demo`, answer each from the pitch and facts only, and write `[not answered]` where they
   don't say. Save to `.roundtable/answers.txt` and run `table.py answers --file .roundtable/answers.txt`.
4. **The vote.** Spawn the firms again, all at once, with the case (now with the answers). Each writes
   `.roundtable/votes/<seat>.json`:
   `{"firm": "<seat>", "verdict": "fund|fund if|pass", "why": "one or two plain lines, in this firm's voice", "fix": ["for a pass or a fund if: exactly what to change to get this firm to fund you"], "quotes": [{"words": "exact words from the pitch or the answers", "note": "what this did to the firm"}]}`.
5. **Check.** `table.py check`. It throws out any vote whose quotes are not really in the pitch or the answers, and any
   pass or fund-if with no fix. If any were thrown out, re-run just those firms once with the reason.
6. **Tally.** `table.py tally`. Tell the user in one line how many firms would fund, fund if, and pass.
7. **Coach.** Spawn the coach with `.roundtable/tally.json`, `.roundtable/votes.json` and the case. It writes
   `.roundtable/coach.json`: `{"first": "the new opening line of the pitch, using one real fact from the case only", "fixes": ["the 3 changes that would win the most votes, each naming the firms it wins and quoting the paragraph it changes"]}`.
   Only facts from the case and the votes; anything only the founder knows is `[fill in: ...]`.
8. **Report.** `table.py report`. Show the user the vote count, the fix-first line, the 3 fixes, the table of how each
   firm voted and what it wants fixed, and where `.roundtable/REPORT.md` is.

## Notes

- Never edit a firm's file. If one is wrong, `grill` or `check` throws it out and that firm runs again.
- 15-17 sub-agents per run (7 firms twice, plus the coach). Nothing is sent to anyone: it's practice on your computer.
- The firms are Claudes playing each firm's public investing advice. They are not the real firms, and no firm made or
  endorses this. Use it to fix your pitch before the real meeting.
- End every Markdown file you write in `.roundtable/` with the same credit line `table.py` uses:
  `_Made with [/roundtable](https://github.com/alexyc9381/vc-roundtable-skill), a free Claude Code skill by Alex Chen ([@nocodealex](https://instagram.com/nocodealex))._`
  JSON files get no footer.
