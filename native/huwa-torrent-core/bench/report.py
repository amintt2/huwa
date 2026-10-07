#!/usr/bin/env python3
"""Tables from the bench's --out files (JSON lines).

  bench/report.py cells  <before.jsonl...> -- <after.jsonl...>   before/after per profile x file x scenario
  bench/report.py cache  <files...>                                one row per file (cache cap / fill cell, stalls cell)
  bench/report.py storm  <file>                                    first vs later starts, resources

Values: median / worst over the runs, in seconds. A run without a first frame (or without the
seek's frame) within the timeout makes the worst "timeout" and is counted in "miss".
"""
import json
import os
import statistics
import sys
from collections import OrderedDict


def runs_of(paths):
    out = []
    for p in paths:
        for line in open(p):
            d = json.loads(line)
            d["_file"] = os.path.basename(p)
            out.append(d)
    return out


def med_worst(vals, miss):
    if not vals:
        return "timeout" if miss else "—"
    med = statistics.median_low(sorted(vals)) / 1000
    worst = "timeout" if miss else f"{max(vals) / 1000:.2f}"
    return f"{med:.2f} / {worst}"


def field(runs, name):
    vals = [r[name] for r in runs if r.get(name) is not None]
    return med_worst(vals, len(runs) - len(vals))


def cells(args):
    i = args.index("--") if "--" in args else len(args)
    groups = []
    for paths in (args[:i], args[i + 1:]):
        g = OrderedDict()
        for r in runs_of(paths):
            if "storm" in r:
                continue
            g.setdefault((r["profile"], r["file"], r["scenario"]), []).append(r)
        groups.append(g)
    b, a = groups
    keys = list(b) + [k for k in a if k not in b]
    print("| profile | file | scenario | before: start→frame | after: start→frame | after: tap→frame | before: seek | after: seek | runs |")
    print("|---|---|---|---|---|---|---|---|---|")
    for k in keys:
        rb, ra = b.get(k, []), a.get(k, [])
        seek = k[2] == "seek"
        print(
            f"| {k[0]} | {k[1]} | {k[2]} | {field(rb, 'start_to_frame_ms') if rb else '—'} | {field(ra, 'start_to_frame_ms') if ra else '—'} "
            f"| {field(ra, 'tap_to_frame_ms') if ra else '—'} | {field(rb, 'seek_ms') if rb and seek else ''} | {field(ra, 'seek_ms') if ra and seek else ''} "
            f"| {len(rb)} / {len(ra)} |"
        )


def cache(paths):
    print("| cell | profile | scenario | start→frame | engine launch ms (median) | disk written to the frame MiB (median) | evictions (count, ms) | stalls: count, paused s (all runs) | runs |")
    print("|---|---|---|---|---|---|---|---|---|")
    for p in paths:
        g = OrderedDict()
        for r in runs_of([p]):
            if "storm" in r:
                continue
            g.setdefault((r["profile"], r["scenario"]), []).append(r)
        for (prof, scen), rs in g.items():
            launch = statistics.median_low(sorted(r.get("launch_ms", 0) for r in rs))
            written = statistics.median_low(sorted(max(0, (r.get("disk_at_frame_mib") or 0) - (r.get("disk_before_mib") or 0)) for r in rs))
            ev = [r.get("evictions") or {} for r in rs]
            ev_count = sum(e.get("count", 0) for e in ev if isinstance(e, dict))
            ev_ms = sum(e.get("total_ms", 0) for e in ev if isinstance(e, dict))
            stalls = f'{sum(r.get("stalls", 0) for r in rs)}, {sum(r.get("stall_ms", 0) or 0 for r in rs) / 1000:.1f}'
            cell = os.path.basename(p).replace(".jsonl", "")
            print(f"| {cell} | {prof} | {scen} | {field(rs, 'start_to_frame_ms')} | {launch} | {written} | {ev_count}, {ev_ms} | {stalls} | {len(rs)} |")


def storm(paths):
    for p in paths:
        rows = [r["storm"] for r in runs_of([p]) if "storm" in r]
        print(f"### {os.path.basename(p)}")
        for prof in ("popular", "obscure"):
            v = [r for r in rows if r["profile"] == prof]
            if not v:
                continue
            first = v[0].get("start_to_frame_ms")
            rest = [r.get("start_to_frame_ms") for r in v[1:]]
            ok = [x for x in rest if x is not None]
            print(
                f"- {prof}: first start {first / 1000 if first is not None else 'none'} s; later starts median "
                f"{statistics.median_low(sorted(ok)) / 1000 if ok else '—'} s, worst {max(ok) / 1000 if ok else '—'} s, "
                f"no frame {sum(1 for x in rest if x is None)}/{len(rest)}"
            )
        last = rows[-1]["res"] if rows else {}
        peak = {k: max(r["res"].get(k, 0) for r in rows) for k in ("live", "peers", "net_conns", "tasks", "rss_mib", "fds", "disk_mib")}
        print(f"- resources at the end: {last}")
        print(f"- peaks: {peak}")


def floor(args):
    """floor <floor.jsonl> -- <after cells jsonl...>: actual first frame vs floor, overhead."""
    i = args.index("--")
    floors = OrderedDict()
    for r in runs_of(args[:i]):
        f = r.get("floor")
        if not f:
            continue
        floors.setdefault((f["profile"], f["file"], f["scenario"]), []).append(f)
    actual = OrderedDict()
    for r in runs_of(args[i + 1:]):
        if "storm" in r or "floor" in r:
            continue
        actual.setdefault((r["profile"], r["file"], r["scenario"]), []).append(r)
    print("| profile | file | scenario | need KiB | floor (median) | first frame (median) | overhead | overhead % | runs floor / frame |")
    print("|---|---|---|---|---|---|---|---|---|")
    for k, fs in floors.items():
        fv = sorted(f["floor_ms"] for f in fs if f.get("floor_ms") is not None)
        av = sorted(r["start_to_frame_ms"] for r in actual.get(k, []) if r.get("start_to_frame_ms") is not None)
        fm = statistics.median_low(fv) if fv else None
        am = statistics.median_low(av) if av else None
        over = (am - fm) if (fm is not None and am is not None) else None
        pct = f"{100 * over / am:.0f} %" if over is not None and am else "—"
        fmt = lambda v: f"{v / 1000:.2f}" if v is not None else "—"
        print(f"| {k[0]} | {k[1]} | {k[2]} | {fs[0].get('need_kib')} | {fmt(fm)} | {fmt(am)} | {fmt(over)} | {pct} | {len(fs)} / {len(actual.get(k, []))} |")


if __name__ == "__main__":
    mode, rest = sys.argv[1], sys.argv[2:]
    {"cells": cells, "cache": cache, "storm": storm, "floor": floor}[mode](rest)
