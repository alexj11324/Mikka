"""Choose a directory through the Linux Desktop smoke job's real GTK dialog."""
import os
import re
import subprocess
import sys
import time

import pyatspi as atspi


def command(*args):
    return subprocess.check_output(args, text=True, timeout=8).strip()


def visible(node):
    return node.getState().contains(atspi.STATE_SHOWING)


def until(read, error):
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        result = read()
        if result is not None:
            return result
        time.sleep(0.1)
    raise RuntimeError(error)


def descend(node):
    yield node
    for child in node:
        if child is not None and visible(child):
            yield from descend(child)


title = r"^(Open|Select|Choose)( (a |an )?(File|Folder|Directory))?$"
window = command("xdotool", "search", "--sync", "--onlyvisible", "--name", title)
if not window.isdecimal() or "_NET_WM_WINDOW_TYPE_DIALOG" not in command(
    "xprop", "-id", window, "_NET_WM_WINDOW_TYPE"
):
    raise RuntimeError("NATIVE_FOLDER_DIALOG_AMBIGUOUS")
command("xdotool", "windowfocus", "--sync", window)


def current_dialog():
    matches = [window for app in atspi.Registry.getDesktop(0) for window in app
               if re.fullmatch(title, window.name or "", re.IGNORECASE) and visible(window)]
    if len(matches) > 1:
        raise RuntimeError("NATIVE_FOLDER_DIALOG_AMBIGUOUS")
    return matches[0] if matches else None


dialog = until(current_dialog, "NATIVE_FOLDER_DIALOG_ACCESSIBILITY_MISSING")
if len(sys.argv) == 2:
    selected = os.path.normpath(sys.argv[1])
    command("xdotool", "key", "ctrl+l")

    def location_entry():
        for node in descend(dialog):
            state = node.getState()
            if state.contains(atspi.STATE_EDITABLE) and state.contains(atspi.STATE_FOCUSED):
                return node
        return None

    entry = until(location_entry, "NATIVE_FOLDER_LOCATION_ENTRY_MISSING")
    entry.queryEditableText().setTextContents(selected)
    until(lambda: True if os.path.normpath(entry.queryText().getText(0, -1)) == selected else None,
          "NATIVE_FOLDER_LOCATION_NOT_SET")
    labels = {"open", "select", "choose", "select folder", "open folder"}
else:
    labels = {"cancel"}


def action_button():
    for node in descend(dialog):
        if (node.getRole() == atspi.ROLE_PUSH_BUTTON and
                (node.name or "").replace("_", "").strip().casefold() in labels and
                node.getState().contains(atspi.STATE_SENSITIVE)):
            return node
    return None


button = until(action_button, "NATIVE_FOLDER_RESPONSE_BUTTON_MISSING")
bounds = button.queryComponent().getExtents(atspi.DESKTOP_COORDS)
command("xdotool", "mousemove", str(bounds.x + bounds.width // 2),
        str(bounds.y + bounds.height // 2), "click", "1")
