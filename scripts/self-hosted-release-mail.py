#!/usr/bin/env python3
"""Deliver a GitHub Releases notification from a local MTA to the host receiver."""
import argparse
import email.policy
import hashlib
import hmac
import http.client
import json
from pathlib import Path
import re
import sys
from email.parser import BytesParser

# Only forward a stable tag. Message-supplied URLs, commands, manifests and
# images never leave this process. Compare the repository name case-insensitively.
LINK = re.compile(
    r"https://(?i:github\.com/alexj11324/mikka)/releases/tag/"
    r"(v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?=[\s<>?#\"')\]]|$)",
    re.ASCII,
)


def release_tag(message):
    # Release notes can mention prior tags. If several tags appear, select
    # only the one identified by the stable workflow's release title.
    tags = set()
    for part in message.walk():
        if part.get_content_type() not in ("text/plain", "text/html") or part.get_content_disposition() == "attachment":
            continue
        body = part.get_payload(decode=True) or b""
        text = body.decode("utf-8", errors="replace")
        tags.update(tag for tag in LINK.findall(text) if len(tag) <= 64)
    if len(tags) == 1:
        return tags.pop()
    subject = str(message.get("Subject", "")).strip()
    # GitHub's release notification subject convention ends with "(TAG)".
    for tag in tags:
        if re.search(r"\bMikka self-hosted " + re.escape(tag) + r"(?![a-zA-Z0-9.-])", subject):
            return tag
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--secret-file", required=True, type=Path)
    parser.add_argument("--port", default=37499, type=int)
    args = parser.parse_args()
    raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        print("SELF_HOSTED_UPDATE_RELEASE_MAIL_TOO_LARGE", file=sys.stderr)
        return 65
    tag = release_tag(BytesParser(policy=email.policy.default).parsebytes(raw))
    if not tag:
        return 0
    payload = json.dumps({"tag": tag}, separators=(",", ":")).encode()
    secret = args.secret_file.read_bytes().rstrip(b"\r\n")
    if len(secret) < 32:
        print("SELF_HOSTED_UPDATE_WEBHOOK_CONFIG_INVALID", file=sys.stderr)
        return 75
    signature = hmac.new(secret, payload, hashlib.sha256).hexdigest()
    conn = http.client.HTTPConnection("127.0.0.1", args.port, timeout=20)
    try:
        conn.request("POST", "/self-hosted-release-hint", payload, {
            "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=" + signature
        })
        status = conn.getresponse().status
    except (OSError, http.client.HTTPException):
        print("SELF_HOSTED_UPDATE_RELEASE_MAIL_UNDELIVERED", file=sys.stderr)
        return 75
    finally:
        conn.close()
    if status not in (202, 204):
        print("SELF_HOSTED_UPDATE_RELEASE_MAIL_REJECTED", status, file=sys.stderr)
        return 75
    return 0


if __name__ == "__main__":
    sys.exit(main())
