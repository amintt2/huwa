#!/usr/bin/env python3
"""Writes a tiny Blu-ray PGS subtitle stream (.sup): FFmpeg has no PGS encoder.

Two captions (a filled box with a border, palette-coloured), each shown for ~0.8 s. Enough to
check that a player decodes and draws HDMV PGS bitmaps (mpv: sd_lavc + pgssub decoder).

Usage: make-pgs.py out.sup [width height]
"""
import struct
import sys

W, H = (int(sys.argv[2]), int(sys.argv[3])) if len(sys.argv) > 3 else (320, 180)
TICKS = 90000  # PTS clock


def segment(kind: int, pts: float, payload: bytes) -> bytes:
    t = int(pts * TICKS)
    return b"PG" + struct.pack(">IIBH", t, 0, kind, len(payload)) + payload


def rle(pixels: list[list[int]]) -> bytes:
    out = bytearray()
    for row in pixels:
        i = 0
        while i < len(row):
            c = row[i]
            n = 1
            while i + n < len(row) and row[i + n] == c and n < 16383:
                n += 1
            if c != 0 and n < 3:
                out += bytes([c]) * n
            elif c == 0:
                out += bytes([0, n]) if n < 64 else bytes([0, 0x40 | (n >> 8), n & 0xFF])
            else:
                out += bytes([0, 0x80 | n, c]) if n < 64 else bytes([0, 0xC0 | (n >> 8), n & 0xFF, c])
            i += n
        out += b"\x00\x00"  # end of line
    return bytes(out)


def caption(start: float, end: float, number: int, x: int, y: int, w: int, h: int) -> bytes:
    # 1 = white border, 2 = yellow fill (Y, Cr, Cb, A).
    # Palette id 0, version 0, then (id, Y, Cr, Cb, A) entries.
    pal = bytes([0, 0]) + bytes([1, 235, 128, 128, 255]) + bytes([2, 210, 146, 16, 255])
    pixels = [[1 if r in (0, h - 1) or c in (0, w - 1) else 2 for c in range(w)] for r in range(h)]
    data = rle(pixels)
    ods_body = struct.pack(">HH", w, h) + data
    ods = struct.pack(">HBB", 1, 0, 0xC0) + len(ods_body).to_bytes(3, "big") + ods_body
    pcs = struct.pack(">HHBHBBBB", W, H, 0x10, number, 0x80, 0, 0, 1) + struct.pack(">HBBHH", 1, 0, 0, x, y)
    wds = struct.pack(">BBHHHH", 1, 0, x, y, w, h)
    show = segment(0x16, start, pcs) + segment(0x17, start, wds) + segment(0x14, start, pal) + segment(0x15, start, ods) + segment(0x80, start, b"")
    clear_pcs = struct.pack(">HHBHBBBB", W, H, 0x10, number + 1, 0x00, 0, 0, 0)
    hide = segment(0x16, end, clear_pcs) + segment(0x17, end, wds) + segment(0x80, end, b"")
    return show + hide


with open(sys.argv[1], "wb") as f:
    f.write(caption(0.1, 0.9, 0, W // 4, H * 2 // 3, W // 2, H // 6))
    f.write(caption(1.0, 1.9, 2, W // 4, H // 8, W // 2, H // 6))
