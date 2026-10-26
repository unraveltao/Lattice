#!/usr/bin/env python3
"""把各尺寸 PNG 打包成 Windows .ico（PNG 内嵌格式，Vista+ 支持）。仅用标准库。"""
import struct
import sys
from pathlib import Path

PNG_DIR = Path(__file__).parent / "png"
OUT = Path(__file__).parent / "lattice.ico"
SIZES = [16, 24, 32, 48, 64, 128, 256]


def main() -> int:
    entries = []
    for s in SIZES:
        p = PNG_DIR / f"appicon-{s}.png"
        if not p.exists():
            print(f"missing {p}", file=sys.stderr)
            return 1
        entries.append((s, p.read_bytes()))

    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = len(header) + 16 * len(entries)
    body = b""
    dirs = b""
    for s, data in entries:
        dim = 0 if s >= 256 else s
        dirs += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        body += data
        offset += len(data)

    OUT.write_bytes(header + dirs + body)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {len(entries)} sizes: {SIZES})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
