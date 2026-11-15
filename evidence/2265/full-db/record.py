"""Keep every named test outcome, suite boundaries and counts in a public QA receipt."""
import datetime
import json
import os
import re
import sys

dest = sys.argv[1]
known = {}
selection = []
ok = set()
cases = 0
start = datetime.datetime.now(datetime.timezone.utc)
ansi = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")
def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()
def save(name, data):
    with open(os.path.join(dest, name), "w") as f:
        json.dump(data, f, ensure_ascii=False)
def clean(x):
    x = re.sub(r"(?:https?|postgres(?:ql)?)://\S+", "[endpoint]", x)
    return re.sub(r"(?:Bearer\s+[A-Za-z0-9._-]+|gh[pousr]_[A-Za-z0-9_]+)", "[redacted]", x)
with open(os.path.join(dest, "named-checks.jsonl"), "w") as named:
    for line in sys.stdin:
        text = ansi.sub("", line.rstrip())
        for tag,name in [("Required DB inventory: ", "inventory"),("Required DB selection: ", "selection"),("Required DB timings: ", "timings"),("Required DB clones: ", "database-clones")]:
            if text.startswith(tag):
                obj = json.loads(text[len(tag):])
                save(name+".json",obj)
                if name == "selection":
                    selection = obj["scripts"]
                    print("official selection",len(selection), "shard", obj["shard"])
                if name=="timings":
                    print("official completed suite timings", len(obj["suites"]))
        result = re.fullmatch(r"(test:[\w:-]+): OK",text)
        if result:
            ok.add(result[1]); print(text)
        if text.startswith("::error::"):
            print(clean(text))
        match = re.match(r"\[db-runner ([^ ]+) (stdout|stderr|lifecycle)\] (.*)",text)
        if not match:
            continue
        suite,stream,body=match.groups()
        if stream == "lifecycle":
            known.setdefault(suite,[]).append({"at":stamp(),"lifecycle":body}); print(suite,body);continue
        linebody = body.strip()
        if (re.match(r"^(?:ok |not ok |# Subtest: |✔ |✖ |▶ |✗ |✓ |ℹ (tests|pass|fail|cancelled|skipped|todo) [0-9]+|# (tests|pass|fail|cancelled|skipped|todo) [0-9]+)",linebody)):
            named.write(json.dumps({"at":stamp(),"suite":suite,"check":clean(linebody)},ensure_ascii=False)+"\n"); cases+=1
        if re.search(r"^(?:not ok |✖ |AssertionError|error:|code:|expected:|actual:)",linebody):
            print(suite, clean(linebody))
save("suite-lifecycle.json",known);save("result.json",{"ok":sorted(ok),"selection":selection,"namedOutcomeLines":cases,"started":start.isoformat(),"finished":stamp()})
if set(selection)!=ok or set(selection)!=set(known) or len(selection)!=86 or cases==0:
    print("full original gates did not all finish:",len(selection),len(ok),len(known),cases)
    sys.exit(1)
