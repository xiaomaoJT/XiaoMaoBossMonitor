#!/usr/bin/env python3
"""
处理 XiaoMao logo：
1. 把白底抠成透明（只清掉与画面边缘连通的白色，保留人物白衬衫）
2. 裁掉四周留白
3. 产出：
   - public/logo/logo-mark.png        透明方形原图（顶栏 / 关于页用）
   - build/icon.iconset/*.png         macOS 图标集
   - build/icon.icns                  macOS 应用图标
   - build/icon.png                   electron-builder 备用
   - ios-icon-1024.png                iOS AppIcon（等生成 iOS 工程后拷入）
"""
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter

ROOT = "/Users/xiaomao/Documents/Projects/Demo/Monitor"
SRC = os.path.join(ROOT, "public/logo/logo.png")
BUILD = os.path.join(ROOT, "build")
os.makedirs(BUILD, exist_ok=True)

BG = (7, 9, 15)          # app 背景 #07090f
BG_TOP = (16, 23, 36)    # #101724
ACCENT = (47, 139, 255)  # #2f8bff


# ---------------------------------------------------------------- 抠白底
def knock_out_white(src, dst):
    im = Image.open(src).convert("RGBA")
    seeds = [(0, 0), (im.width - 1, 0), (0, im.height - 1),
             (im.width - 1, im.height - 1),
             (im.width // 2, 0), (im.width // 2, im.height - 1),
             (0, im.height // 2), (im.width - 1, im.height // 2)]
    for xy in seeds:
        if im.getpixel(xy)[:3] >= (246, 246, 246):
            ImageDraw.floodfill(im, xy, (0, 0, 0, 0), thresh=14)

    # 边缘轻微收缩，去掉残留的白边
    a = im.getchannel("A").point(lambda v: 0 if v < 24 else v)
    im.putalpha(a)

    bbox = im.getbbox()
    im = im.crop(bbox)
    im.save(dst)
    print(f"✓ 透明 logo：{im.size[0]}x{im.size[1]} -> {dst}")
    return im


# ---------------------------------------------------------------- 圆角底板
def rounded_card(size, radius_ratio=0.225):
    """深色渐变 + 蓝色描边的圆角卡片（macOS / iOS 图标底）"""
    card = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(card)
    r = int(size * radius_ratio)
    box = (0, 0, size - 1, size - 1)

    # 垂直渐变
    grad = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        t = y / max(1, size - 1)
        c = tuple(int(BG_TOP[i] + (BG[i] - BG_TOP[i]) * t) for i in range(3)) + (255,)
        gd.line([(0, y), (size, y)], fill=c)

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=r, fill=255)
    card.paste(grad, (0, 0), mask)

    # 描边 + 顶部微光
    d = ImageDraw.Draw(card)
    d.rounded_rectangle(box, radius=r, outline=(47, 139, 255, 90), width=max(2, size // 256))
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        (-size * 0.25, -size * 0.42, size * 1.25, size * 0.42), fill=(47, 139, 255, 46)
    )
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.05))
    card = Image.alpha_composite(card, Image.composite(glow, Image.new("RGBA", card.size, (0, 0, 0, 0)), mask))
    return card, mask


def make_app_icon(logo, out_png, size=1024):
    card, mask = rounded_card(size)
    inner = int(size * 0.62)
    lw = int(inner * 0.92)
    lh = int(logo.height * lw / logo.width)
    if lh > inner:
        lh = inner
        lw = int(logo.width * lh / logo.height)
    l = logo.resize((lw, lh), Image.LANCZOS)
    card.alpha_composite(l, ((size - lw) // 2, (size - lh) // 2))

    out = card.resize((size, size), Image.LANCZOS)
    out.save(out_png)
    print(f"✓ 图标 {size}x{size} -> {out_png}")
    return out


def split_mark_and_wordmark(logo):
    """在下方 45% 区域里找一条「整行全透明」的分隔线，把骑行小人和文字拆开"""
    w, h = logo.size
    a = logo.getchannel("A")
    px = a.load()
    cut = None
    for y in range(int(h * 0.55), h - 4):
        if all(px[x, y] == 0 for x in range(0, w, 2)):
            cut = y
            break
    if cut is None:
        return logo
    mark = logo.crop((0, 0, w, cut))
    # 再裁一次，把左右和上下的空白去掉
    b = mark.getbbox()
    mark = mark.crop(b)
    print(f"✓ 拆出骑行小人 mark：{mark.size[0]}x{mark.size[1]}（分隔线 y={cut}）")
    return mark


def main():
    mark_path = os.path.join(ROOT, "public/logo/logo-mark.png")
    logo = knock_out_white(SRC, mark_path)
    mark = split_mark_and_wordmark(logo)

    # macOS / iOS 图标：用方形化后的骑行小人
    side = max(mark.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.alpha_composite(mark, ((side - mark.width) // 2, (side - mark.height) // 2))

    iconset = os.path.join(BUILD, "icon.iconset")
    os.makedirs(iconset, exist_ok=True)
    ic = make_app_icon(sq, os.path.join(BUILD, "icon.png"), 1024)
    for s in (16, 32, 64, 128, 256, 512, 1024):
        ic.resize((s, s), Image.LANCZOS).save(os.path.join(iconset, f"icon_{s}x{s}.png"))
        if s <= 512:
            ic.resize((s * 2, s * 2), Image.LANCZOS).save(
                os.path.join(iconset, f"icon_{s}x{s}@2x.png")
            )
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(BUILD, "icon.icns")], check=True)
    print("✓ build/icon.icns")

    # iOS AppIcon（Xcode 14+ 单尺寸 1024）
    make_app_icon(sq, os.path.join(ROOT, "build", "ios-icon-1024.png"), 1024)

    # 顶栏用：完整 logo（含小帽集团文字）
    logo.resize((320, int(320 * logo.height / logo.width)), Image.LANCZOS).save(mark_path)
    print("✓ 顶栏 logo-mark.png（320 宽，含文字）")


if __name__ == "__main__":
    sys.exit(main())
