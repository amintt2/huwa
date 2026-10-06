#!/usr/bin/env python3
"""Before/after tables from the bench's --out files (JSON lines).

  bench/report.py target/bench-results/baseline-*.jsonl -- target/bench-results/after-*.jsonl

Cells: profile x file x scenario (and prefill/cap for the cache runs when given with --cache).
Each value: median / worst over the runs, in seconds; "miss" = runs without a first frame (or
without the seek's frame) within the timeout, which make the worst a timeout.
"""
import json
import statistics
import sys
from collections import OrderedDict


def load(paths):
    cells = OrderedDict()
    storm = []
    for p in paths:
        for line in open(p):
            d = json.loads(line)
            if "storm" in d:
                storm.append(d)
                continue
            key = (d["profile"], d["file"], d["scenario"])
            cells.setdefault(key, []).append(d)
    return cells, storm


def stat(runs, field):
    vals = [r[field] for r in runs if r.get(field) is not None]
    miss = len(runs) - len(vals)
    if not vals:
        return "timeout" if miss else "—", miss
    med = statistics.median_low(sorted(vals)) / 1000
    worst = "timeout" if miss else f"{max(vals) / 1000:.2f}"
    return f"{med:.2f} / {worst}", miss


def main():
    args = sys.argv[1:]
    if "--" in args:
        i = args.index("--")
        before, after = args[:i], args[i + 1:]
    else:
        before, after = args, []
    b, _ = load(before)
    a, _ = load(after) if after else ({}, [])
    keys = list(b.keys()) + [k for k in a.keys() if k not in b]
    print("| profile | file | scenario | before start→frame (median / worst) | after | before seek | after seek | n before / after |")
    print("|---|---|---|---|---|---|---|---|")
    for k in keys:
        rb, ra = b.get(k, []), a.get(k, [])
        sb, _ = stat(rb, "start_to_frame_ms") if rb else ("—", 0)
        sa, _ = stat(ra, "start_to_frame_ms") if ra else ("—", 0)
        kb, _ = stat(rb, "seek_ms") if rb and k[2] == "seek" else ("", 0)
        ka, _ = stat(ra, "seek_ms") if ra and k[2] == "seek" else ("", 0)
        print(f"| {k[0]} | {k[1]} | {k[2]} | {sb} | {sa} | {kb} | {ka} | {len(rb)} / {len(ra)} |")


if __name__ == "__main__":
    main()
