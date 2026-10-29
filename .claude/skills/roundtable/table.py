#!/usr/bin/env python3
"""The VC Roundtable for /roundtable: splits your pitch into numbered paragraphs, seats the firms, keeps only
questions and votes that quote your real words, counts who would fund you, and writes the report.

Everything lives in .roundtable/ in the folder you run it from. Standard library only (Python 3.8+).

  table.py setup --text FILE --goal "..." [--about FILE] [--seed N] [--firms 7]
                     write .roundtable/case.json: your pitch split into numbered paragraphs, and the firms seated
  table.py grill     read .roundtable/questions/*.json, keep the questions that quote your pitch
                     -> .roundtable/grill.json (and grill.md, the questions to answer, in one list)
  table.py answers --file FILE
                     save your answers to the grilling (one paragraph per question, in order) -> case.json
  table.py check     read .roundtable/votes/*.json, keep the votes whose every quote is really in your pitch or
                     your answers, and where every pass names a fix -> .roundtable/votes.json
  table.py tally     count fund / fund if / pass, and the paragraphs the firms quoted most -> .roundtable/tally.json
  table.py report    write .roundtable/REPORT.md (uses .roundtable/coach.json when it is there)
"""
import argparse
import json
import random
import re
import sys
from collections import Counter
from pathlib import Path

HOME = Path(".roundtable")
CREDIT = ("_Made with [/roundtable](https://github.com/alexyc9381/vc-roundtable-skill), a free Claude Code skill by "
          "Alex Chen ([@nocodealex](https://instagram.com/nocodealex))._")
NOTE = ("The firms are Claudes playing each firm's public investing advice. They are not the real firms, and no firm "
        "made or endorses this. Use it to fix your pitch before the real meeting. Nothing was sent to anyone.")
VERDICTS = ["fund", "fund if", "pass"]
YES = "fund"
# seat, name, how this seat judges (from each firm's own public advice to founders)
FIRMS = [
    ["y-combinator", "Y Combinator", "wants a small team that ships fast, talks to users every week and can say what it does in one line"],
    ["sequoia", "Sequoia", "wants a clear why now, a big market and a company that could still matter in 20 years"],
    ["a16z", "a16z", "bets on technical founders building software that changes how a whole industry works"],
    ["benchmark", "Benchmark", "funds few companies, wants one founder it would follow anywhere and a product people already love"],
    ["founders-fund", "Founders Fund", "wants a contrarian idea most people think is wrong, and a reason you are right"],
    ["accel", "Accel", "looks for early proof: real usage, real revenue, customers who come back without being asked"],
    ["lightspeed", "Lightspeed", "asks how big this gets and what stops a bigger company from copying it next quarter"],
    ["kleiner-perkins", "Kleiner Perkins", "wants a hard problem, a team that knows it from the inside and a plan for the first 10 hires"],
    ["general-catalyst", "General Catalyst", "asks how this makes money for years and what the numbers look like at 10 times the size"],
    ["index", "Index Ventures", "wants a product that can sell in many countries and a founder who knows the unit economics cold"],
]
ALWAYS = ["y-combinator", "sequoia", "a16z"]
UNIT = "paragraph"


def norm(s):
    """Same text whatever the quotes, dashes and spacing: used to check a quote is really there."""
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    s = s.replace("—", "-").replace("–", "-")
    return re.sub(r"\s+", " ", s).strip().lower()


def split(text):
    text = text.strip()
    if not text:
        sys.exit("the pitch is empty")
    parts = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    return [{"n": i + 1, "text": p} for i, p in enumerate(parts)]


def seat(n=7, seed=None):
    rng = random.Random(seed)
    rest = [f for f in FIRMS if f[0] not in ALWAYS]
    rng.shuffle(rest)
    pick = [f for f in FIRMS if f[0] in ALWAYS] + rest[:max(0, n - len(ALWAYS))]
    return [{"seat": s, "name": nm, "who": who} for s, nm, who in pick[:n]]


def save(name, data):
    HOME.mkdir(exist_ok=True)
    (HOME / name).write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")


def load(name, hint):
    f = HOME / name
    if not f.exists():
        sys.exit(hint)
    return json.loads(f.read_text())


def case():
    return load("case.json", "run `table.py setup ...` first")


def setup(text, goal, about="", seed=None, firms=7):
    data = {"goal": goal, "about": about.strip(), "text": text.strip(), "units": split(text),
            "firms": seat(firms, seed), "seed": seed, "answers": []}
    save("case.json", data)
    return data


def _read(folder, c):
    seats = {f["seat"] for f in c["firms"]}
    good, bad = [], []
    for f in sorted((HOME / folder).glob("*.json")):
        try:
            a = json.loads(f.read_text())
        except ValueError:
            bad.append({"file": f.name, "why": ["not valid JSON"]})
            continue
        if a.get("firm") not in seats:
            bad.append({"file": f.name, "why": ["not a firm at this table"]})
            continue
        good.append((f.name, a))
    return good, bad


def grill():
    """Keep each firm's questions that quote the pitch; number them for the founder."""
    c = case()
    whole = norm(c["text"])
    good, dropped = _read("questions", c)
    names = {f["seat"]: f["name"] for f in c["firms"]}
    asked = []
    for fname, a in good:
        why = []
        qs = a.get("questions") or []
        if not qs:
            why.append("no questions")
        for q in qs:
            w = norm(str(q.get("quote", "")))
            if not str(q.get("ask", "")).strip():
                why.append("a question is empty")
            elif not w or w not in whole:
                why.append(f"quote not in the pitch: {str(q.get('quote', ''))[:60]!r}")
        if why:
            dropped.append({"file": fname, "firm": a.get("firm"), "why": why})
            continue
        for q in qs:
            asked.append({"n": len(asked) + 1, "firm": a["firm"], "name": names[a["firm"]],
                          "ask": q["ask"].strip(), "quote": q["quote"].strip()})
    save("grill.json", {"asked": asked, "dropped": dropped})
    L = ["# The grilling", "", "Answer each one in a sentence or two, in order, one paragraph per answer.", ""]
    L += [f"{q['n']}. **{q['name']}:** {q['ask']}  (about: \"{q['quote']}\")" for q in asked]
    (HOME / "grill.md").write_text("\n".join(L) + "\n")
    return asked, dropped


def answers(text):
    c = case()
    asked = load("grill.json", "run `table.py grill` first")["asked"]
    parts = [p.strip() for p in re.split(r"\n\s*\n", text.strip()) if p.strip()]
    c["answers"] = [{"n": q["n"], "firm": q["firm"], "ask": q["ask"],
                     "answer": parts[i] if i < len(parts) else "[not answered]"} for i, q in enumerate(asked)]
    save("case.json", c)
    return c["answers"]


def problems(a, c):
    """Why a vote can't be kept (empty list = keep it)."""
    out = []
    v = a.get("verdict")
    if v not in VERDICTS:
        out.append(f"verdict must be one of {', '.join(VERDICTS)}")
    if not str(a.get("why", "")).strip():
        out.append("why is empty")
    if v in ("pass", "fund if") and not [f for f in (a.get("fix") or []) if str(f).strip()]:
        out.append("a pass or a fund-if must say what to fix (fix is empty)")
    quotes = a.get("quotes") or []
    if not quotes:
        out.append("no quotes: every point must quote the pitch or the founder's answers")
    whole = norm(c["text"] + "\n" + "\n".join(x["answer"] for x in c.get("answers", [])))
    for q in quotes:
        w = norm(str(q.get("words", "")))
        if not w or w not in whole:
            out.append(f"quote not in the pitch or answers: {str(q.get('words', ''))[:60]!r}")
    return out


def check():
    c = case()
    good, dropped = _read("votes", c)
    kept = []
    for fname, a in good:
        p = problems(a, c)
        (dropped.append({"file": fname, "firm": a.get("firm"), "why": p}) if p else kept.append(a))
    save("votes.json", {"kept": kept, "dropped": dropped})
    return kept, dropped


def where(q, c):
    w = norm(q)
    for u in c["units"]:
        if w and w in norm(u["text"]):
            return u["n"]
    return None


def tally():
    c = case()
    kept = load("votes.json", "run `table.py check` first")["kept"]
    verdicts = Counter(a["verdict"] for a in kept)
    hot = Counter()
    for a in kept:
        for q in a.get("quotes", []):
            n = where(q.get("words", ""), c)
            if n:
                hot[n] += 1
    t = {"table": len(kept), "yes": verdicts.get(YES, 0), "verdicts": {v: verdicts.get(v, 0) for v in VERDICTS},
         "most_quoted": [{"n": n, "times": k} for n, k in hot.most_common(3)], "units": len(c["units"])}
    save("tally.json", t)
    return t


def report():
    c, t = case(), load("tally.json", "run `table.py tally` first")
    kept = load("votes.json", "run `table.py check` first")["kept"]
    coach = json.loads((HOME / "coach.json").read_text()) if (HOME / "coach.json").exists() else {}
    names = {f["seat"]: f["name"] for f in c["firms"]}
    v = t["verdicts"]
    L = ["# The VC Roundtable report", "",
         f"**{t['yes']} of {t['table']}** firms would fund you. {v['fund if']} would fund you if you fix something; "
         f"{v['pass']} passed.", ""]
    if coach.get("first"):
        L += ["## Fix this first", "", coach["first"], ""]
    if coach.get("fixes"):
        L += ["## The fixes that win the most votes", ""] + [f"{i}. {f}" for i, f in enumerate(coach["fixes"], 1)] + [""]
    L += ["## How each firm voted", "", "| Firm | Vote | Why | What to fix |", "|---|---|---|---|"]
    for a in kept:
        why = str(a["why"]).replace("|", "/").replace("\n", " ")
        fix = "; ".join(str(f) for f in (a.get("fix") or [])).replace("|", "/").replace("\n", " ") or "-"
        L.append(f"| {names.get(a['firm'], a['firm'])} | {a['verdict']} | {why} | {fix} |")
    if c.get("answers"):
        L += ["", "## The grilling", ""]
        L += [f"{x['n']}. **{names.get(x['firm'], x['firm'])}:** {x['ask']}  \n   You: {x['answer']}" for x in c["answers"]]
    L += ["", "## Your pitch, numbered", ""] + [f"{u['n']}. {u['text']}" for u in c["units"]]
    L += ["", NOTE, "", CREDIT, ""]
    (HOME / "REPORT.md").write_text("\n".join(L))
    return HOME / "REPORT.md"


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("setup")
    s.add_argument("--text", required=True, help="a file with your pitch, one slide or point per paragraph")
    s.add_argument("--goal", required=True, help="what you are raising and for what")
    s.add_argument("--about", default="", help="a file: the real numbers and facts behind the pitch")
    s.add_argument("--seed", type=int)
    s.add_argument("--firms", type=int, default=7)
    an = sub.add_parser("answers")
    an.add_argument("--file", required=True, help="your answers, one paragraph per question, in order")
    for n in ("grill", "check", "tally", "report"):
        sub.add_parser(n)
    a = p.parse_args(argv)
    if a.cmd == "setup":
        about = Path(a.about).read_text() if a.about else ""
        d = setup(Path(a.text).read_text(), a.goal, about, a.seed, max(len(ALWAYS), min(a.firms, len(FIRMS))))
        print(f"{len(d['units'])} {UNIT}s · at the table: " + ", ".join(f["name"] for f in d["firms"]))
    elif a.cmd == "grill":
        asked, dropped = grill()
        print(f"{len(asked)} questions kept, {len(dropped)} firms thrown out -> .roundtable/grill.md")
        for d in dropped:
            print(f"  {d['file']}: {'; '.join(d['why'])}")
    elif a.cmd == "answers":
        n = answers(Path(a.file).read_text())
        print(f"{sum(1 for x in n if x['answer'] != '[not answered]')} of {len(n)} questions answered")
    elif a.cmd == "check":
        kept, dropped = check()
        print(f"kept {len(kept)}, thrown out {len(dropped)}")
        for d in dropped:
            print(f"  {d['file']}: {'; '.join(d['why'])}")
    elif a.cmd == "tally":
        t = tally()
        print(f"{t['yes']} of {t['table']} would fund; {t['verdicts']['fund if']} fund if; {t['verdicts']['pass']} pass")
    else:
        print(report())


if __name__ == "__main__":
    main()
