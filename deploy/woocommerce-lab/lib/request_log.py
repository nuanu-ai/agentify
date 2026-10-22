"""Prints the requests the lab shop's Caddy logged between two moments.

    python3 -I request_log.py [--since WHEN] [--until WHEN] [--agent TEXT] < log lines

The log lines are Caddy's JSON access log, current and rolled files together,
in any order. WHEN is a moment in UTC written as 2026-10-22T09:30 (seconds and
a trailing Z optional), or a span back from now such as 15m, 2h or 1d. --agent
keeps the requests whose User-Agent contains TEXT, ignoring case; --agent ''
keeps those that sent none. Each request is one line: its time in UTC, method,
status, duration in milliseconds, User-Agent and path. The path is as the log
holds it, with credentials already replaced by REDACTED.
"""

import argparse
import json
import re
import sys
from datetime import datetime, timedelta, timezone


def moment(text):
    span = re.fullmatch(r"(\d+)([smhd])", text)
    if span:
        unit = {"s": "seconds", "m": "minutes", "h": "hours", "d": "days"}[span.group(2)]
        return datetime.now(timezone.utc) - timedelta(**{unit: int(span.group(1))})
    try:
        parsed = datetime.fromisoformat(text.rstrip("Z"))
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} is neither a moment like 2026-10-22T09:30 nor a span like 15m")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--since", type=moment)
    parser.add_argument("--until", type=moment)
    parser.add_argument("--agent")
    args = parser.parse_args()

    rows = []
    for line in sys.stdin:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get("msg") != "handled request":
            continue
        at = datetime.fromtimestamp(entry["ts"], timezone.utc)
        if (args.since and at < args.since) or (args.until and at > args.until):
            continue
        agent = entry.get("user_agent") or ""
        if args.agent is not None:
            if args.agent == "" and agent:
                continue
            if args.agent and args.agent.lower() not in agent.lower():
                continue
        request = entry.get("request", {})
        rows.append((at, request.get("method", "?"), entry.get("status", "?"),
                     round(entry.get("duration", 0) * 1000), agent or "(none)", request.get("uri", "?")))

    rows.sort(key=lambda row: row[0])
    for at, method, status, millis, agent, uri in rows:
        print(f"{at.strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3]}Z  {method:<6} {status}  {millis:>6} ms  {agent}  {uri}")
    print(f"{len(rows)} requests.", file=sys.stderr)


if __name__ == "__main__":
    main()
