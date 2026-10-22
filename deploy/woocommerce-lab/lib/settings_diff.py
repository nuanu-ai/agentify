"""Prints every difference between two settings readings of the lab shop.

    python3 -I settings_diff.py <earlier.json> <later.json>

A reading is the JSON that seed/reading.php prints. Each difference is one
line naming the section and the setting, with the earlier value and the later
one; a setting that only one reading has is shown as added or removed. The
exit status is 0 when the readings agree and 1 when they differ.
"""

import json
import sys


def flatten(value, path, out):
    if isinstance(value, dict) and value:
        for key, inner in value.items():
            flatten(inner, path + [str(key)], out)
    elif isinstance(value, list) and value and any(isinstance(v, (dict, list)) for v in value):
        for index, inner in enumerate(value):
            flatten(inner, path + [str(index)], out)
    else:
        out[tuple(path)] = value


def show(value):
    if isinstance(value, str):
        return repr(value) if len(value) <= 120 else repr(value[:117] + "...")
    return json.dumps(value, ensure_ascii=False)


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    readings = []
    for name in sys.argv[1:]:
        with open(name, encoding="utf-8") as handle:
            reading = json.load(handle)
        flat = {}
        flatten({k: v for k, v in reading.items() if k != "taken_at"}, [], flat)
        readings.append((reading.get("taken_at", "?"), flat))
    (earlier_at, earlier), (later_at, later) = readings
    print(f"From the reading taken {earlier_at} to the one taken {later_at}:")
    differences = 0
    section = None
    for key in sorted(set(earlier) | set(later)):
        if earlier.get(key, KeyError) == later.get(key, KeyError):
            continue
        differences += 1
        if key[0] != section:
            section = key[0]
            print(f"\n{section}")
        name = " › ".join(key[1:]) or "(the whole section)"
        if key not in earlier:
            print(f"  added    {name}: {show(later[key])}")
        elif key not in later:
            print(f"  removed  {name}: was {show(earlier[key])}")
        else:
            print(f"  changed  {name}: {show(earlier[key])} → {show(later[key])}")
    if not differences:
        print("\nNo differences.")
        return 0
    print(f"\n{differences} differences.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
