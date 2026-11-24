"""Render the desktop brand SVG's rounded rectangles and strokes for launchers."""
import binascii
from functools import lru_cache
import math
from pathlib import Path
import struct
import xml.etree.ElementTree as ET
import zlib

BRAND = Path(__file__).resolve().parents[1] / "frontend/src/brand.svg"
NS = "{http://www.w3.org/2000/svg}"


def colors(value):
    return tuple(bytes.fromhex(value.removeprefix("#")))


def rounded_rect(element):
    x, y, width, height, radius = (float(element.get(key)) for key in ("x","y","width","height","rx"))

    def distance(px, py):
        dx = abs(px - x - width / 2) - width / 2 + radius
        dy = abs(py - y - height / 2) - height / 2 + radius
        return math.hypot(max(dx, 0), max(dy, 0)) + min(max(dx, dy), 0) - radius

    return colors(element.get("fill")), distance


def stroke(element):
    points = [tuple(map(float, point.split(","))) for point in element.get("points").split()]
    segments = [(x,y,u-x,v-y,(u-x)**2+(v-y)**2) for (x,y),(u,v) in zip(points,points[1:])]
    radius = float(element.get("stroke-width")) / 2

    def distance(px, py):
        nearest = math.inf
        for x,y,dx,dy,squared in segments:
            t = min(1, max(0, ((px-x)*dx+(py-y)*dy)/squared))
            nearest = min(nearest, math.hypot(px-x-t*dx, py-y-t*dy))
        return nearest - radius

    return colors(element.get("stroke")), distance


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind+data))


@lru_cache(maxsize=None)
def png_icon(size):
    image = ET.parse(BRAND).getroot()
    if image.get("viewBox") != "0 0 48 48":
        raise ValueError("unexpected brand icon canvas")
    shapes = {NS+"rect":rounded_rect, NS+"polyline":stroke}
    layers = [shapes[element.tag](element) for element in image]
    scale = size / 48

    def pixel(x, y):
        px, py = (x+.5)/scale, (y+.5)/scale
        rgb, alpha = (0,0,0), 0
        # Composite from the top. Skip the covered layers in opaque interiors.
        for color, distance in reversed(layers):
            coverage = min(1, max(0, .5 - distance(px, py)*scale))
            weight = (1-alpha)*coverage
            if weight:
                rgb = tuple(value + channel * weight for value, channel in zip(rgb, color))
                alpha += weight
            if alpha == 1:
                break
        if not alpha:
            return b"\0\0\0\0"
        return bytes((*[round(channel/alpha) for channel in rgb], round(alpha*255)))

    pixels = b"".join(b"\0" + b"".join(pixel(x,y) for x in range(size)) for y in range(size))
    header = struct.pack(">IIBBBBB",size,size,8,6,0,0,0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR",header) + chunk(b"IDAT",zlib.compress(pixels)) + chunk(b"IEND",b"")


def mac_icon():
    entries = []
    for kind, size in ((b"icp4",16),(b"icp5",32),(b"icp6",64),(b"ic07",128),(b"ic08",256),(b"ic09",512),(b"ic10",1024)):
        png = png_icon(size)
        entries.append(kind + struct.pack(">I",len(png)+8) + png)
    data = b"".join(entries)
    return b"icns" + struct.pack(">I",len(data)+8) + data


def windows_icon():
    sizes = (16,24,32,48,64,128,256)
    images = [png_icon(size) for size in sizes]
    offset = 6 + 16 * len(images)
    entries = []
    for size, png in zip(sizes, images):
        entries.append(struct.pack("<BBBBHHII",size % 256,size % 256,0,0,1,32,len(png),offset))
        offset += len(png)
    return struct.pack("<HHH",0,1,len(images)) + b"".join(entries+images)
