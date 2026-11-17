"""Select a repository through the actual Linux Desktop smoke job's X11 dialog."""
import csv
import io
import os
import subprocess
import sys


def run(*args, data=None, timeout=8):
    return subprocess.run(args, input=data, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, timeout=timeout, check=True).stdout


def xdo(*args):
    return run("xdotool", *args).decode().strip()


title = r"^(Open|Select|Choose)( (a |an )?(File|Folder|Directory))?$"
window = xdo("search", "--sync", "--onlyvisible", "--name", title)
if not window.isdecimal() or b"_NET_WM_WINDOW_TYPE_DIALOG" not in run(
    "xprop", "-id", window, "_NET_WM_WINDOW_TYPE"
):
    raise RuntimeError("NATIVE_FOLDER_DIALOG_AMBIGUOUS")
xdo("windowfocus", "--sync", window)

# Electron's native picker need not be present in the renderer or AT-SPI tree.
# Read only the foreground dialog's rendered labels. Its pixels and directory
# entries stay in process memory and never enter an artifact or console log.
def response_buttons():
    image = run("import", "-silent", "-window", window, "png:-")
    words = run("tesseract", "stdin", "stdout", "--psm", "11", "tsv", data=image)
    labels = {"cancel": [], "accept": []}
    for row in csv.DictReader(io.StringIO(words.decode()), delimiter="\t"):
        word = (row.get("text") or "").strip().casefold()
        if word not in {"cancel", "open", "choose", "select"}:
            continue
        x = int(row["left"]) + int(row["width"]) // 2
        y = int(row["top"]) + int(row["height"]) // 2
        labels["cancel" if word == "cancel" else "accept"].append((x, y))
    for cancel in labels["cancel"]:
        same_row = [pt for pt in labels["accept"] if pt[0] > cancel[0] and abs(pt[1] - cancel[1]) <= 8]
        if same_row:
            return cancel, max(same_row)
    raise RuntimeError(f"NATIVE_FOLDER_RESPONSE_LABELS_MISSING(cancel={len(labels['cancel'])},accept={len(labels['accept'])})")


def click(point):
    xdo("mousemove", "--window", window, str(point[0]), str(point[1]), "click", "1")


if len(sys.argv) == 1:
    cancel, _ = response_buttons()
    click(cancel)
else:
    selected = os.path.normpath(sys.argv[1])
    xdo("key", "ctrl+l")
    xdo("type", "--clearmodifiers", "--", selected)
    xdo("key", "ctrl+a", "ctrl+c")
    copied = run("xclip", "-selection", "clipboard", "-o").decode()
    if os.path.normpath(copied) != selected:
        raise RuntimeError("NATIVE_FOLDER_LOCATION_NOT_SET")
    _, accept = response_buttons()
    click(accept)
