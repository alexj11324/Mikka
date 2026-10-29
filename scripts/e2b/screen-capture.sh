#!/bin/bash
set -euo pipefail
# Operator-only entry point: the server runs it through the E2B control plane
# for a thread's own Bot desktop (lib/captures/screen.ts). Never expose it as
# a model tool. Files are the desktop account's own and leave through the
# server, which reads and then discards them.
action=${1:?action required}
display=${2:?display number required}
id=${3:?capture id required}
[[ "$action" =~ ^(shot|record|started|stop|discard)$ ]] || exit 2
[[ "$display" =~ ^[1-9][0-9]{0,2}$ ]] || exit 2
[[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || exit 2
if [ "$action" = record ]; then
  seconds=${4:?seconds required}
  [[ "$seconds" =~ ^[0-9]{1,3}$ ]] && (( seconds >= 5 && seconds <= 300 )) || exit 2
fi
command -v ffmpeg >/dev/null || exit 5
umask 077
dir=${MIKKA_CAPTURE_DIR:-/home/user/.mikka/captures}
mkdir -p "$dir"
chmod 700 "$dir"
# Whatever nobody collected (the server lost the sandbox, a run ended
# mid-upload) goes after an hour, so nothing piles up between captures.
find "$dir" -maxdepth 1 -type f -mmin +60 -delete 2>/dev/null || true
# The desktops are 1280x800 (start-desktop.sh, SCREEN_WIDTH/HEIGHT).
grab=(-nostdin -loglevel error -f x11grab -video_size 1280x800)
case "$action" in
  shot)
    ffmpeg "${grab[@]}" -i ":$display" -frames:v 1 -y "$dir/$id.png"
    ;;
  record)
    # One recording per desktop. The lock lives as long as this script.
    exec 9>"$dir/record-$display.lock"
    flock -n 9 || exit 3
    echo "$id" > "$dir/record-$display.id"
    # -t ends ffmpeg on its own and timeout kills it if it hangs, so no
    # recording outlives its limit even if nobody ever asks it to stop.
    timeout -s INT -k 10 $((seconds + 10)) ffmpeg "${grab[@]}" -framerate 10 -i ":$display" -t "$seconds" \
      -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p -movflags +faststart -y "$dir/$id.mp4" || true
    rm -f "$dir/record-$display.id"
    touch "$dir/$id.done"
    ;;
  started)
    for _ in $(seq 1 25); do
      grep -qx "$id" "$dir/record-$display.id" 2>/dev/null && pgrep -f "^ffmpeg .*/$id\.mp4$" >/dev/null && exit 0
      [ -f "$dir/$id.done" ] && exit 4
      sleep .2
    done
    exit 4
    ;;
  stop)
    # SIGINT makes ffmpeg write the index and exit cleanly.
    pkill -INT -f "^ffmpeg .*/$id\.mp4$" || true
    for _ in $(seq 1 100); do [ -f "$dir/$id.done" ] && break; sleep .2; done
    [ -f "$dir/$id.done" ] && [ -s "$dir/$id.mp4" ] || exit 4
    ffprobe -v error -show_entries format=duration -of csv=p=0 "$dir/$id.mp4" || echo 0
    ;;
  discard)
    pkill -KILL -f "^ffmpeg .*/$id\.mp4$" || true
    rm -f "$dir/$id.png" "$dir/$id.mp4" "$dir/$id.done"
    ;;
esac
