"""Choose a visible child folder in the smoke job's real, isolated X11 dialog."""
import csv
import io
import subprocess
import sys
import time


def run(*args, data=None):
    return subprocess.run(args, input=data, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, timeout=8, check=True).stdout


def xdo(*args):
    return run("xdotool", *args).decode().strip()


title = r"^(Open|Select|Choose)( (a |an )?(File|Folder|Directory))?$"
window = xdo("search", "--sync", "--onlyvisible", "--name", title)
if not window.isdecimal() or b"_NET_WM_WINDOW_TYPE_DIALOG" not in run(
    "xprop", "-id", window, "_NET_WM_WINDOW_TYPE"
):
    raise RuntimeError("NATIVE_FOLDER_DIALOG_AMBIGUOUS")
xdo("windowfocus", "--sync", window)

# Only fixed test/control words leave this process. Unknown directory names,
# paths, whole frames and clipboard content never enter evidence.
allowed = {"fixture", "source", "cancel", "open", "choose", "select",
           "error", "ok", "location", "search", "folder", "recent", "name"}


def read_labels():
    image = run("import", "-silent", "-window", window, "-resize", "200%", "png:-")
    words = run("tesseract", "stdin", "stdout", "--psm", "11", "tsv", data=image)
    labels = {}
    for row in csv.DictReader(io.StringIO(words.decode()), delimiter="\t"):
        word = (row.get("text") or "").strip(" _|[]").casefold()
        if word in allowed:
            x = (int(row["left"]) + int(row["width"]) // 2) // 2
            y = (int(row["top"]) + int(row["height"]) // 2) // 2
            labels.setdefault(word, []).append((x, y))
    return labels


def wait_for(label):
    deadline = time.monotonic() + 6
    while True:
        observed = read_labels()
        if label in observed:
            return observed
        if time.monotonic() >= deadline:
            raise RuntimeError(f"NATIVE_FOLDER_{label.upper()}_MISSING {observed}")
        time.sleep(0.15)


def click(point):
    xdo("mousemove", "--window", window, str(point[0]), str(point[1]), "click", "1")


if sys.argv[1] == "choose":
    entries = wait_for("fixture")
    # The bookmark is the left sidebar item, even if the current folder name
    # also appears in the location bar.
    click(min(entries["fixture"]))
    entries = wait_for("source")
    click(max(entries["source"], key=lambda p: p[1]))
    print("selected visible Source row in Fixture", flush=True)

labels = wait_for("cancel")
for cancel in labels["cancel"]:
    accept = [pt for name in ("open", "choose", "select") for pt in labels.get(name, [])
              if pt[0] > cancel[0] and abs(pt[1] - cancel[1]) <= 8]
    if accept:
        click(cancel if sys.argv[1] == "cancel" else max(accept))
        print("clicked", "cancel" if sys.argv[1] == "cancel" else "affirmative", flush=True)
        break
else:
    raise RuntimeError(f"NATIVE_FOLDER_RESPONSE_LABELS_MISSING {labels}")

# The Electron renderer is the authority for the result. If the modeless X11
# window remains mapped, report the new controls without taking another action.
time.sleep(0.6)
try:
    if window in xdo("search", "--onlyvisible", "--name", title).splitlines():
        print("after click", read_labels(), flush=True)
except subprocess.CalledProcessError:
    pass
