#!/usr/bin/env python3

"""Refuse a release archive that cannot be extracted under one exact root."""

import sys
import tarfile
from pathlib import PurePosixPath


def refuse(message: str) -> None:
    print(f"release archive refused: {message}", file=sys.stderr)
    raise SystemExit(65)


if len(sys.argv) != 3:
    refuse("expected <archive.tar.gz> <exact-root>")

archive_path, expected_root = sys.argv[1:]
if not expected_root or "/" in expected_root or expected_root in (".", ".."):
    refuse("the expected root is not one directory name")

member_count = 0
try:
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive:
            member_count += 1
            path = PurePosixPath(member.name)
            if path.is_absolute() or not path.parts or ".." in path.parts:
                refuse(f"unsafe member path: {member.name}")
            if path.parts[0] != expected_root:
                refuse(f"member is outside {expected_root}: {member.name}")

            if member.issym():
                target = PurePosixPath(member.linkname)
                if target.is_absolute():
                    refuse(f"unsafe link target: {member.name}")
                resolved = list(path.parent.parts)
                for part in target.parts:
                    if part in ("", "."):
                        continue
                    if part == "..":
                        if len(resolved) <= 1:
                            refuse(f"unsafe link target: {member.name}")
                        resolved.pop()
                    else:
                        resolved.append(part)
                if not resolved or resolved[0] != expected_root:
                    refuse(f"unsafe link target: {member.name}")
            elif not (member.isfile() or member.isdir()):
                refuse(f"unsafe member type: {member.name}")
except (OSError, tarfile.TarError) as error:
    refuse(f"archive cannot be read: {error}")

if member_count == 0:
    refuse("archive is empty")

print(f"release archive accepted under {expected_root}")
