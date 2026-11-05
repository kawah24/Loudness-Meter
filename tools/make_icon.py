"""Draws the app icon and writes a multi-resolution .ico (PNG-compressed entries)."""
from PIL import Image, ImageDraw
import io, os, struct

OUT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICO = os.path.join(OUT_DIR, "Loudness Meter.ico")

AMBER = (255, 181, 69, 255)
BG = (15, 19, 27, 255)
EDGE = (44, 52, 68, 255)


def draw(size):
    """Render one icon at `size` px, supersampled 4x for clean edges."""
    ss = 4
    n = size * ss
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    radius = n * 0.23
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=radius, fill=BG)
    if size >= 32:
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=radius,
                            outline=EDGE, width=max(1, int(n * 0.012)))

    # bar geometry: three chunky bars when tiny, five when there is room
    if size <= 24:
        fracs, bw, gap = [0.52, 0.96, 0.36], 0.17, 0.10
    else:
        fracs, bw, gap = [0.34, 0.63, 0.95, 0.55, 0.23], 0.115, 0.055

    total = len(fracs) * bw + (len(fracs) - 1) * gap
    x = n * (1 - total) / 2
    inner_h = n * 0.58
    top = n * 0.21

    for f in fracs:
        h = inner_h * f
        y0 = top + (inner_h - h) / 2
        d.rounded_rectangle(
            [x, y0, x + n * bw, y0 + h],
            radius=n * bw / 2,
            fill=AMBER,
        )
        x += n * (bw + gap)

    return img.resize((size, size), Image.LANCZOS)


def build_ico(sizes):
    images = [draw(s) for s in sizes]
    blobs = []
    for im in images:
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        blobs.append(buf.getvalue())

    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    for im, blob in zip(images, blobs):
        w = 0 if im.width >= 256 else im.width
        h = 0 if im.height >= 256 else im.height
        entries += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)

    with open(ICO, "wb") as f:
        f.write(header + entries + b"".join(blobs))
    return images


if __name__ == "__main__":
    sizes = [256, 128, 64, 48, 32, 16]
    imgs = build_ico(sizes)
    imgs[0].save(os.path.join(OUT_DIR, "tests", "icon-preview.png"))
    print("wrote", ICO, os.path.getsize(ICO), "bytes")
