#!/usr/bin/env python3
"""
Extract the glyph outlines the Kinora logo needs into branding/kinora/source/glyphs.json, so the logo can be
rebuilt as plain SVG paths without the fonts installed and without any runtime dependency.

  name     "Kinora" in Bricolage Grotesque ExtraBold (wght 800, opsz 96)  -- the Lumen display face
  tagline  "YOUR OWN HOME CINEMA." in Figtree Bold (wght 700)             -- the Lumen text face

Both fonts are SIL OFL 1.1 and already in the repo's node_modules (the web app self-hosts them from
@fontsource-variable/*). They are variable WOFF2 files, so they are instanced at the weights above first.

Only needed when changing the typeface or the text:

  python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools brotli uharfbuzz
  /tmp/ft/bin/python scripts/brand/extract-glyphs.py

Paths are at 1000 units/em with the baseline at y = 0 and y growing downwards (as in SVG), absolute M/L/Q/C/Z only.
Pair kerning comes from shaping each pair with HarfBuzz (GPOS), so it matches what a browser would do.
"""
import io
import json
import os

import uharfbuzz as hb
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
FS = os.path.join(REPO, 'node_modules', '@fontsource-variable')
ROLES = {
    'name': {
        'file': os.path.join(FS, 'bricolage-grotesque', 'files', 'bricolage-grotesque-latin-standard-normal.woff2'),
        'font': 'Bricolage Grotesque',
        'axes': {'wght': 800, 'opsz': 96, 'wdth': 100},
        'text': 'Kinora',
    },
    'tagline': {
        'file': os.path.join(FS, 'figtree', 'files', 'figtree-latin-wght-normal.woff2'),
        'font': 'Figtree',
        'axes': {'wght': 700},
        'text': 'YOUR OWN HOME CINEMA.',
    },
}


def fmt(v):
    s = ('%.2f' % v).rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def contours(rec, scale):
    """RecordingPen value -> list of contour path strings (y flipped)."""
    out, cur = [], ''
    P = lambda p: f'{fmt(p[0] * scale)} {fmt(-p[1] * scale)}'
    for op, pts in rec.value:
        if op == 'moveTo':
            cur = 'M' + P(pts[0])
        elif op == 'lineTo':
            cur += 'L' + P(pts[0])
        elif op == 'qCurveTo':
            # TrueType implied on-curve points between consecutive off-curve points.
            *offs, end = pts
            if end is None:
                raise ValueError('closed off-curve-only contours are not supported')
            for i, c in enumerate(offs):
                nxt = end if i == len(offs) - 1 else ((c[0] + offs[i + 1][0]) / 2, (c[1] + offs[i + 1][1]) / 2)
                cur += 'Q' + P(c) + ' ' + P(nxt)
        elif op == 'curveTo':
            cur += 'C' + ' '.join(P(p) for p in pts)
        elif op in ('closePath', 'endPath'):
            out.append(cur + 'Z')
            cur = ''
    return out


def top_of(contour):
    nums = [float(n) for n in __import__('re').findall(r'-?\d*\.?\d+', contour)]
    return min(nums[1::2])


out = {'licence': 'SIL Open Font License 1.1', 'roles': {}}
for role, spec in ROLES.items():
    vf = TTFont(spec['file'])
    axes = {k: v for k, v in spec['axes'].items() if k in {a.axisTag for a in vf['fvar'].axes}}
    font = instantiateVariableFont(vf, axes)
    font.flavor = None  # plain sfnt for HarfBuzz
    buf = io.BytesIO()
    font.save(buf)
    data = buf.getvalue()
    scale = 1000 / font['head'].unitsPerEm
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    hbfont = hb.Font(hb.Face(data))

    def shape(text):
        b = hb.Buffer()
        b.add_str(text)
        b.guess_segment_properties()
        hb.shape(hbfont, b, {'kern': True, 'liga': False})
        return sum(p.x_advance for p in b.glyph_positions) * scale

    chars = sorted(set(spec['text']))
    glyphs = {}
    for c in chars:
        name = cmap[ord(c)]
        rec = DecomposingRecordingPen(gs)
        gs[name].draw(rec)
        cs = contours(rec, scale)
        g = {'adv': round(gs[name].width * scale, 2), 'd': ''.join(cs)}
        if c == 'i' and len(cs) == 2:
            # Keep the tittle separate: the wordmark lights it in the beam colours.
            cs.sort(key=top_of)
            g['d'] = cs[1]
            g['dot'] = cs[0]
        glyphs[c] = g
    kern = {}
    text = spec['text']
    for a, b in {(text[i], text[i + 1]) for i in range(len(text) - 1)}:
        v = shape(a + b) - glyphs[a]['adv'] - glyphs[b]['adv']
        if abs(v) > 0.01:
            kern[a + b] = round(v, 2)
    os2 = font['OS/2']
    out['roles'][role] = {
        'font': spec['font'],
        'axes': spec['axes'],
        'text': text,
        'capHeight': round(os2.sCapHeight * scale),
        'xHeight': round(os2.sxHeight * scale),
        'ascender': round(font['hhea'].ascent * scale),
        'glyphs': glyphs,
        'kern': dict(sorted(kern.items())),
    }

dest = os.path.join(REPO, 'branding', 'kinora', 'source', 'glyphs.json')
os.makedirs(os.path.dirname(dest), exist_ok=True)
with open(dest, 'w') as fh:
    json.dump(out, fh, indent=1)
    fh.write('\n')
print('Wrote', os.path.relpath(dest, REPO))
