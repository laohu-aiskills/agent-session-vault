#!/usr/bin/env python3
"""
生成应用图标 build/icon.ico。

不依赖 Pillow：用标准库 zlib 手写 PNG 编码，再按 ICO 规范（PNG-in-ICO，
Windows Vista+ 支持）组装多尺寸图标。

图形语义：深色圆角底 + 三条会话记录横条，首条高亮 —— 与工具的用途对应。
4 倍超采样后降采样，得到抗锯齿边缘。

用法：python tools/make-icon.py
"""

import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'build', 'icon.ico')
SIZES = [256, 128, 64, 48, 32, 16]
SS = 4  # 超采样倍数

# 配色（深色底 + 青色强调）
BG_TOP = (43, 58, 85)
BG_BOTTOM = (18, 26, 38)
BAR_ACCENT = (56, 189, 248)
BAR_2 = (148, 163, 184)
BAR_3 = (100, 116, 139)


def in_round_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    # 四个角做圆角判定
    cx = x0 + r if x < x0 + r else (x1 - r if x > x1 - r else x)
    cy = y0 + r if y < y0 + r else (y1 - r if y > y1 - r else y)
    if cx == x and cy == y:
        return True
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def render(size):
    """返回 size×size 的 RGBA bytes"""
    n = size * SS
    s = n / 256.0  # 以 256 为设计基准
    acc = [0] * (size * size * 4)

    def rr(x, y, x0, y0, x1, y1, r):
        return in_round_rect(x, y, x0 * s, y0 * s, x1 * s, y1 * s, r * s)

    for py in range(n):
        for px in range(n):
            # 底板
            if not rr(px, py, 10, 10, 246, 246, 54):
                continue
            t = py / n
            col = tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))

            # 三条会话记录，首条高亮
            bars = [
                (58, 82, 198, 100, 9, BAR_ACCENT),
                (58, 120, 168, 138, 9, BAR_2),
                (58, 158, 186, 176, 9, BAR_3),
            ]
            for (x0, y0, x1, y1, r, c) in bars:
                if rr(px, py, x0, y0, x1, y1, r):
                    col = c
                    break

            # 累加到降采样格子
            ox, oy = px // SS, py // SS
            i = (oy * size + ox) * 4
            acc[i] += col[0]
            acc[i + 1] += col[1]
            acc[i + 2] += col[2]
            acc[i + 3] += 255

    cnt = SS * SS
    out = bytearray(size * size * 4)
    for k in range(size * size):
        i = k * 4
        a = acc[i + 3] // cnt
        if a == 0:
            continue
        # 按覆盖度归一化颜色，避免边缘发暗
        out[i] = acc[i] // cnt
        out[i + 1] = acc[i + 1] // cnt
        out[i + 2] = acc[i + 2] // cnt
        out[i + 3] = a
    return bytes(out)


def to_png(size, rgba):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter: None
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
            + chunk(b'IEND', b''))


def main():
    images = [(sz, to_png(sz, render(sz))) for sz in SIZES]

    header = struct.pack('<HHH', 0, 1, len(images))
    offset = len(header) + 16 * len(images)
    entries, blobs = b'', b''
    for sz, png in images:
        b = 0 if sz >= 256 else sz  # 256 在 ICO 里用 0 表示
        entries += struct.pack('<BBBBHHII', b, b, 0, 0, 1, 32, len(png), offset)
        blobs += png
        offset += len(png)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'wb') as f:
        f.write(header + entries + blobs)
    print(f'已生成 {os.path.abspath(OUT)}  ({os.path.getsize(OUT)} bytes, {len(images)} 种尺寸)')


if __name__ == '__main__':
    main()
