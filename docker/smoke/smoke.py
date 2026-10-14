#!/usr/bin/env python3
"""Smoke test of a running Huwa server (docker image or native binary). Standard library only.

  smoke.py full   --base http://127.0.0.1:8080 --seeds seeds.jsonl [--compat]
  smoke.py web    --base http://127.0.0.1:8080

`full` (the `huwa:<v>` image), with the local seeder's JSON lines (examples/seeder.rs):
  - info / health / huwa-config / noindex;
  - H.264/AAC MKV: remux decision, HLS master / playlist / init / segment 0, seek to 80 % in < 5 s
    (segment time checked against the playlist), ASS sidecar (VTT + ASS);
  - Hi10P + AC3: transcode decision, a second transcode refused (429) while it runs, seek to
    80 % in < 5 s;
  - session isolation (404 on another session's media and torrent), stream quota (429),
    sessions per IP (429);
  - with --compat: Stremio routes (settings, create with guessedFileIdx, stream 206, stats,
    /hlsv2/probe and master).
`web` (the `huwa:<v>-web` image): no engine (404), web app and config served.
"""

import argparse
import json
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:8080"


def log(*a):
    print(*a, flush=True)


def fail(msg):
    print(f"FAIL: {msg}", flush=True)
    sys.exit(1)


def check(cond, msg):
    if not cond:
        fail(msg)
    log(f"  ok  {msg}")


def req(method, path, body=None, headers=None, timeout=120):
    url = path if path.startswith("http") else BASE + path
    data = None
    h = dict(headers or {})
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        h.setdefault("content-type", "application/json")
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()


def j(b):
    try:
        return json.loads(b)
    except Exception:
        return None


def session(xff=None):
    h = {"x-forwarded-for": xff} if xff else {}
    st, _, b = req("POST", "/api/v1/session", {}, h)
    return st, j(b)


def call(tok, method, args):
    st, _, b = req("POST", f"/api/v1/engine/{method}", args, {"authorization": f"Bearer {tok}"})
    return st, j(b)


# ---- MP4 helpers -----------------------------------------------------------------------------

def boxes(b, start, end):
    out, p = [], start
    while p + 8 <= end:
        size, typ = struct.unpack(">I4s", b[p:p + 8])
        hdr = 8
        if size == 1:
            size = struct.unpack(">Q", b[p + 8:p + 16])[0]
            hdr = 16
        elif size == 0:
            size = end - p
        if size < hdr or p + size > end:
            break
        out.append((typ, p, hdr, size))
        p += size
    return out


def find(b, start, end, path):
    for typ, p, hdr, size in boxes(b, start, end):
        if typ == path[0]:
            return (p, hdr, size) if len(path) == 1 else find(b, p + hdr, p + size, path[1:])
    return None


def timescale(init):
    p, hdr, _ = find(init, 0, len(init), [b"moov", b"trak", b"mdia", b"mdhd"])
    d = p + hdr
    off = d + 4 + (16 if init[d] == 1 else 8)
    return struct.unpack(">I", init[off:off + 4])[0]


def first_tfdt(frag):
    for typ, p, hdr, size in boxes(frag, 0, len(frag)):
        if typ != b"moof":
            continue
        for t2, p2, h2, s2 in boxes(frag, p + hdr, p + size):
            if t2 != b"traf":
                continue
            tp, th, _ = find(frag, p2 + h2, p2 + s2, [b"tfhd"])
            if struct.unpack(">I", frag[tp + th + 4:tp + th + 8])[0] != 1:
                continue
            dp, dh, _ = find(frag, p2 + h2, p2 + s2, [b"tfdt"])
            d = dp + dh
            return struct.unpack(">Q", frag[d + 4:d + 12])[0] if frag[d] == 1 else struct.unpack(">I", frag[d + 4:d + 8])[0]
    return None


def seg_starts(playlist):
    t, out = 0.0, []
    for line in playlist.splitlines():
        if line.startswith("#EXTINF:"):
            out.append(t)
            t += float(line[8:].rstrip(","))
    return out


class Hls:
    def __init__(self, master_url, caps):
        st, h, b = req("GET", f"{master_url}?{caps}")
        if st != 200:
            raise RuntimeError(f"master {st}: {b[:300]!r}")
        self.master = b.decode()
        self.referrer = h.get("referrer-policy")
        variant = next(l for l in self.master.splitlines() if l.endswith("index.m3u8"))
        self.base = master_url.rsplit("/", 1)[0] + "/" + variant[: -len("/index.m3u8")]
        st, _, b = req("GET", f"{self.base}/index.m3u8")
        check(st == 200, "media playlist")
        self.playlist = b.decode()
        self.starts = seg_starts(self.playlist)
        st, _, b = req("GET", f"{self.base}/init.mp4")
        check(st == 200, "init segment")
        self.ts = timescale(b)

    def segment(self, k):
        t0 = time.monotonic()
        st, h, b = req("GET", f"{self.base}/{k}.m4s")
        took = time.monotonic() - t0
        if st != 200:
            fail(f"segment {k}: {st} {b[:300]!r}")
        return took, first_tfdt(b) / self.ts


def wait_stream(url):
    t0 = time.monotonic()
    st, h, b = req("GET", url, headers={"range": "bytes=0-1023"}, timeout=120)
    check(st == 206 and len(b) == 1024, f"torrent stream 206 ({time.monotonic() - t0:.1f} s to first bytes)")
    check(h.get("referrer-policy") == "no-referrer", "media responses send Referrer-Policy: no-referrer")


def probe(tok, url, caps):
    st, _, b = req("POST", f"/api/v1/media/probe?{caps}", {"url": url}, {"authorization": f"Bearer {tok}"}, timeout=180)
    if st != 200:
        fail(f"probe {st}: {b[:300]!r}")
    return j(b)


def full(args):
    seeds = {}
    for line in open(args.seeds):
        line = line.strip()
        if line.startswith("{"):
            d = json.loads(line)
            seeds[d["file"].rsplit("/", 1)[-1].split(".")[0]] = d
    for k in ("h264_aac", "hi10p_ac3", "hevc_ac3"):
        if k not in seeds:
            fail(f"seed {k} missing")
    log("== info")
    st, h, b = req("GET", "/health")
    check(st == 200 and b == b"ok", "/health")
    info = j(req("GET", "/api/v1/info")[2])
    check(info["features"]["seeding"] is False and info["features"]["torrent"] and info["features"]["transcode"], f"features {info['features']}")
    check(h.get("x-robots-tag", "").startswith("noindex"), "X-Robots-Tag: noindex")
    check(j(req("GET", "/huwa-config.json")[2])["v"] == 1, "/huwa-config.json")

    caps = "videoCodecs=h264&audioCodecs=aac&maxAudioChannels=2"
    st, a = session()
    check(st == 201, "session A")
    ta = a["token"]

    log("== remux H.264/AAC MKV")
    s = seeds["h264_aac"]
    st, r = call(ta, "startStream", {"infoHash": s["infoHash"], "sources": [s["source"]]})
    check(st == 200, "startStream")
    wait_stream(r["url"])
    p = probe(ta, r["url"], caps)
    check(p["decision"]["mode"] == "remux", f"decision {p['decision']}")
    check(p["keyframeIndex"] == "cues", "keyframes from the MKV Cues")
    hls = Hls(p["hls"], caps)
    check(hls.referrer == "no-referrer", "playlist Referrer-Policy")
    check("avc1." in hls.master and "mp4a.40.2" in hls.master, "master CODECS")
    took, t = hls.segment(0)
    check(abs(t) < 0.1, f"segment 0 at {t:.3f} s ({took:.2f} s)")
    k = len(hls.starts) * 8 // 10
    took, t = hls.segment(k)
    check(took < 5.0, f"remux seek to 80 % (segment {k}) in {took:.2f} s")
    check(abs(t - hls.starts[k]) < 0.05, f"segment {k} at {t:.3f} s = playlist {hls.starts[k]:.3f} s")
    vtt_url = p["subtitles"][0]["url"]
    deadline, vtt = time.monotonic() + 40, ""
    while time.monotonic() < deadline:
        st, h, b = req("GET", f"{vtt_url}?since=0")
        vtt = b.decode()
        if "Fin" in vtt:
            break
        time.sleep(0.5)
    check(vtt.startswith("WEBVTT") and "Bonjour Huwa" in vtt and "Fin" in vtt, "ASS sidecar as WebVTT")
    st, _, b = req("GET", p["subtitles"][0]["assUrl"])
    check(st == 200 and b"[Script Info]" in b and b"Dialogue:" in b, "ASS sidecar as ASS")

    log("== transcode Hi10P + AC3")
    s = seeds["hi10p_ac3"]
    st, r = call(ta, "startStream", {"infoHash": s["infoHash"], "sources": [s["source"]]})
    check(st == 200, "startStream (second slot)")
    wait_stream(r["url"])
    p = probe(ta, r["url"], caps)
    check(p["decision"]["mode"] == "transcode" and "video:h264-10bit" in p["decision"]["reasons"], f"decision {p['decision']}")
    hls = Hls(p["hls"], caps)
    took, t = hls.segment(0)
    check(abs(t) < 0.1, f"transcoded segment 0 ({took:.2f} s)")

    log("== quotas and isolation")
    s3 = seeds["hevc_ac3"]
    st, r = call(ta, "startStream", {"infoHash": s3["infoHash"], "sources": [s3["source"]]})
    check(st == 429 and r["code"] == "quota_exceeded", "third stream of a session: 429")
    st, bsess = session()
    tb = bsess["token"]
    st, r = call(tb, "status", {"id": seeds["h264_aac"]["infoHash"]})
    check(st == 404, "another session cannot see A's torrent")
    other_master = p["hls"].replace(p["hls"].split("/s/")[1].split("/")[0], tb)
    check(req("GET", other_master)[0] == 404, "another session cannot open A's HLS")
    st, r = call(tb, "startStream", {"infoHash": s3["infoHash"], "sources": [s3["source"]]})
    check(st == 200, "session B starts HEVC")
    wait_stream(r["url"])
    pb = probe(tb, r["url"], caps)
    check(pb["decision"]["mode"] == "transcode", "HEVC → transcode for an H.264-only client")
    st, _, b = req("GET", f"{pb['hls']}?{caps}")
    check(st == 429 and j(b)["kind"] == "transcode_server", f"second transcode while one runs: 429 ({st})")
    took, t = hls.segment(int(len(hls.starts) * 0.8))
    check(took < 5.0, f"transcode seek to 80 % in {took:.2f} s")
    check(abs(t - hls.starts[int(len(hls.starts) * 0.8)]) < 0.1, f"transcoded segment at {t:.2f} s")
    codes = [session("198.51.100.23")[0] for _ in range(12)]
    check(429 in codes, f"sessions per IP: {codes}")

    if args.compat:
        log("== Stremio-compatible routes")
        st, h, b = req("GET", "/settings", headers={"accept": "application/json"})
        check(st == 200 and "baseUrl" in j(b), "/settings")
        s = seeds["h264_aac"]
        body = {"torrent": {"infoHash": s["infoHash"]}, "peerSearch": {"sources": [s["source"]], "min": 40, "max": 150}, "guessFileIdx": {}}
        st, _, b = req("POST", f"/{s['infoHash']}/create", body)
        check(st == 200 and j(b)["guessedFileIdx"] == 0, f"create → guessedFileIdx {j(b) and j(b).get('guessedFileIdx')}")
        st, _, b = req("GET", f"/{s['infoHash']}/0", headers={"range": "bytes=0-99"})
        check(st == 206 and len(b) == 100, "compat stream 206")
        st, _, b = req("GET", f"/{s['infoHash']}/0/stats.json")
        check(st == 200 and j(b)["infoHash"] == s["infoHash"], "compat stats.json")
        media_url = urllib.parse.quote(f"{BASE}/{s['infoHash']}/0", safe="")
        st, _, b = req("GET", f"/hlsv2/probe?mediaURL={media_url}")
        check(st == 200 and [x["track"] for x in j(b)["streams"]] == ["video", "audio", "subtitle"], "/hlsv2/probe")
        st, _, b = req("GET", f"/hlsv2/smoke1/master.m3u8?mediaURL={media_url}&{caps}")
        check(st == 200 and b"index.m3u8" in b, "/hlsv2/<id>/master.m3u8")

    st, _, b = req("GET", "/metrics")
    check(st == 200 and b"huwa_hls_segments_served_total" in b, "/metrics (loopback)")
    log("PASS")


def web(args):
    st, _, b = req("GET", "/health")
    check(st == 200, "/health")
    info = j(req("GET", "/api/v1/info")[2])
    check(info["features"]["torrent"] is False and info["features"]["transcode"] is False and info["engine"] is None, f"-web features {info['features']}")
    st, s = session()
    check(st == 201, "session")
    st, _, _ = req("POST", "/api/v1/engine/list", {}, {"authorization": f"Bearer {s['token']}"})
    check(st == 404, "/api/v1/engine is a 404 in the -web image")
    st, _, b = req("GET", "/")
    check(st == 200 and b"<html" in b.lower(), "web app at /")
    st, _, b = req("GET", "/some/spa/route")
    check(st == 200 and b"<html" in b.lower(), "SPA fallback")
    check(j(req("GET", "/huwa-config.json")[2])["features"]["torrent"] is False, "/huwa-config.json")
    log("PASS")


def main():
    global BASE
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["full", "web"])
    ap.add_argument("--base", default=BASE)
    ap.add_argument("--seeds")
    ap.add_argument("--compat", action="store_true")
    args = ap.parse_args()
    BASE = args.base.rstrip("/")
    for _ in range(60):
        try:
            if req("GET", "/health", timeout=2)[0] == 200:
                break
        except Exception:
            pass
        time.sleep(1)
    (full if args.mode == "full" else web)(args)


if __name__ == "__main__":
    main()
