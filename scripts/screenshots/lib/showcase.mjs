import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as A from './artwork.mjs';
import { DISCOVER_MOVIES, DISCOVER_SHOWS } from '../../e2e/mocks.mjs';
import { STUDIOS } from './catalog.mjs';

/**
 * Extra demo material for the feature screenshots, made once per work folder (marker: showcase.done):
 *   - TMDB-style posters and backdrops for the "not in your library yet" Discover catalogue (assets/tmdb/);
 *   - an HDR10 HEVC version of one film carrying a Dolby Vision 8.1 configuration box, plus an E-AC-3 5.1 track, so the
 *     player shows real HDR / Dolby Vision handling (the browser gets a tone-mapped transcode);
 *   - word-timed lyrics for one song (lyrics and karaoke views).
 */
export const SHOWCASE_VERSION = '3';
export const DV_MOVIE = { slug: 'last-lighthouse-kepler', dir: 'The Last Lighthouse on Kepler (2023)' };
export const LYRICS_TRACK = { artist: 'Neon Cartography', album: 'Afterglow Avenue', file: '01 - Afterglow Avenue' };

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err.slice(0, 400)}`))));
  });
}

/* ------------------------------ MP4 boxes ----------------------------- */

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

function boxes(buf, start, end) {
  const out = [];
  for (let o = start; o + 8 <= end;) {
    let size = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(o + 8));
    else if (size === 0) size = end - o;
    out.push({ type, start: o, size });
    o += size;
  }
  return out;
}

/**
 * Add a Dolby Vision configuration record (dvcC: profile 8, level 6, RPU present, HDR10-compatible base layer, i.e.
 * "Dolby Vision 8.1") to the first HEVC sample entry, growing every parent box. The moov box must come after mdat
 * (FFmpeg's default without +faststart) so chunk offsets stay valid.
 */
export function addDolbyVisionBox(file) {
  const buf = fs.readFileSync(file);
  const top = boxes(buf, 0, buf.length);
  const moov = top.find((b) => b.type === 'moov');
  const mdat = top.find((b) => b.type === 'mdat');
  if (!moov || !mdat || moov.start < mdat.start) throw new Error('addDolbyVisionBox: need moov after mdat');
  let chain = null;
  const walk = (box, parents) => {
    if (chain) return;
    if (box.type === 'stsd') {
      const entry = boxes(buf, box.start + 16, box.start + box.size).find((e) => e.type === 'hvc1' || e.type === 'hev1');
      if (entry) chain = [...parents, box, entry];
      return;
    }
    if (!CONTAINERS.has(box.type)) return;
    for (const c of boxes(buf, box.start + 8, box.start + box.size)) walk(c, [...parents, box]);
  };
  walk(moov, []);
  if (!chain) throw new Error('addDolbyVisionBox: no HEVC sample entry');
  const dvcc = Buffer.alloc(32);
  dvcc.writeUInt32BE(32, 0);
  dvcc.write('dvcC', 4, 'latin1');
  dvcc[8] = 1; // version 1.0
  dvcc[9] = 0;
  // profile(7) level(6) rpu(1) el(1) bl(1): 8, 6, 1, 0, 1
  dvcc.writeUInt16BE((8 << 9) | (6 << 3) | (1 << 2) | (0 << 1) | 1, 10);
  dvcc[12] = 1 << 4; // bl_signal_compatibility_id 1 (HDR10)
  const entry = chain[chain.length - 1];
  const at = entry.start + entry.size;
  for (const b of chain) buf.writeUInt32BE(buf.readUInt32BE(b.start) + 32, b.start);
  fs.writeFileSync(file, Buffer.concat([buf.subarray(0, at), dvcc, buf.subarray(at)]));
}

/* ------------------------------- lyrics ------------------------------- */

const LYRICS = [
  'Neon on the water and the city is awake',
  'Every mile of afterglow is ours to take',
  'Turn the radio up and let the chorus fade',
  'Running down the avenue that we made',
  'Chrome and starlight on the coastal road',
  'Headlights painting all the stories that we told',
  'Hold the moment like a song you know by heart',
  'Afterglow avenue, never fall apart',
  'Neon on the water and the city is awake',
  'Every mile of afterglow is ours to take',
];

/** Enhanced LRC: one line every two bars at 100 BPM, words on the beat and the half-beat. */
export function afterglowLrc() {
  const beat = 0.6;
  const stamp = (x) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${(x % 60).toFixed(2).padStart(5, '0')}`;
  let lrc = '[ti:Afterglow Avenue]\n[ar:Neon Cartography]\n[al:Afterglow Avenue]\n';
  LYRICS.forEach((line, l) => {
    const start = 2.4 + l * 8 * beat;
    const words = line.split(' ');
    const step = Math.min(beat / 2, 3.6 / words.length);
    lrc += `[${stamp(start)}]` + words.map((w, i) => `<${stamp(start + i * step)}>${w} `).join('').trimEnd() + `<${stamp(start + words.length * step)}>\n`;
  });
  return lrc;
}

/* -------------------------------- main -------------------------------- */

export async function generateShowcase({ root, renderer, log }) {
  const marker = path.join(root, 'showcase.done');
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === SHOWCASE_VERSION) return;
  const media = path.join(root, 'media');
  const tmdb = path.join(root, 'assets', 'tmdb');
  log('Making showcase extras (Discover artwork, a Dolby Vision film, word-timed lyrics)…');
  for (const it of [...DISCOVER_MOVIES, ...DISCOVER_SHOWS]) {
    const tv = !it.title;
    const art = { slug: `discover-${it.id}`, title: it.title ?? it.name, year: Number((it.release_date ?? it.first_air_date).slice(0, 4)), style: it.style, pal: it.pal, motif: it.motif, tagline: '', studio: Object.values(STUDIOS)[it.id % 7] };
    await renderer.render(A.posterHtml(art, { tv }), 500, 750, path.join(tmdb, `poster-${it.id}.jpg`), 84);
    await renderer.render(A.backdropHtml(art), 1280, 720, path.join(tmdb, `backdrop-${it.id}.jpg`), 84);
  }

  const dir = path.join(media, 'Movies', DV_MOVIE.dir);
  const file = path.join(dir, `${DV_MOVIE.dir}.mp4`);
  const orig = path.join(root, 'art', `${DV_MOVIE.slug}-sdr.mp4`);
  if (!fs.existsSync(orig)) fs.copyFileSync(file, orig);
  const tmp = path.join(root, 'art', `${DV_MOVIE.slug}-dv.mp4`);
  await ffmpeg([
    '-i', orig, '-f', 'lavfi', '-t', '120', '-i', 'aevalsrc=0.02*sin(2*PI*196*t)|0.02*sin(2*PI*247*t)|0.02*sin(2*PI*294*t)|0.01*sin(2*PI*55*t)|0.015*sin(2*PI*330*t)|0.015*sin(2*PI*392*t):c=5.1:s=48000',
    // Convert the SDR picture into real PQ / BT.2020 (SDR white at 203 nits), so tone-mapping gives a natural image.
    '-vf', 'zscale=tin=709:pin=709:min=709:rin=tv:t=linear:p=709:npl=203,format=gbrpf32le,zscale=p=2020:t=smpte2084:m=2020_ncl:r=tv:npl=203,format=yuv420p10le',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1',
    '-x265-params', 'log-level=error:hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400',
    '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-fps_mode', 'passthrough', '-video_track_timescale', '12288',
    '-c:a', 'eac3', '-b:a', '384k', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English 5.1', tmp,
  ]);
  addDolbyVisionBox(tmp);
  fs.renameSync(tmp, file);

  const album = path.join(media, 'Music', LYRICS_TRACK.artist, LYRICS_TRACK.album);
  fs.writeFileSync(path.join(album, `${LYRICS_TRACK.file}.lrc`), afterglowLrc());
  fs.writeFileSync(marker, SHOWCASE_VERSION);
}
