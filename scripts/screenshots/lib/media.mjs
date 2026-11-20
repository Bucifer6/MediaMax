import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as A from './artwork.mjs';
import { MOVIES, SHOWS, ALBUMS, AUDIOBOOKS, PHOTOS, CHANNELS, PEOPLE } from './catalog.mjs';

/**
 * Builds the demo media tree:
 *   Movies/<Title> (<Year>)/…   TV/<Show> (<Year>)/Season NN/…   Music/<Artist>/<Album>/…
 *   Audiobooks/<Author>/<Title>/…   Photos/<Album>/…
 * plus mock-server assets (headshots, channel logos, live stream clips).
 *
 * Videos look like real titles without being big: a 20 s Ken Burns pan over the backdrop at 24 fps, followed by a
 * variable-frame-rate tail (one frame every 20 s) so the file has a believable feature-length runtime in ~2 MB.
 */

export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const safe = (s) => s.replace(/[\\/:*?"<>|]/g, '');

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err.slice(0, 400)}\n${args.join(' ')}`))));
  });
}

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

/** A feature-length-looking H.264 MP4 from one image (no audio). */
async function longVideo(image, seconds, out, tmp) {
  const base = out.replace(/\.mp4$/, '');
  const a = `${base}.a.mp4`;
  const b = `${base}.b.mp4`;
  const tail = `${base}.tail.jpg`;
  const pan = Math.min(20, seconds);
  await ffmpeg(['-loop', '1', '-framerate', '24', '-i', image, '-t', String(pan), '-vf', `scale=1440:-2,crop=1280:720:x='(iw-1280)*t/${pan}':y='(ih-720)/2',format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-g', '48', '-video_track_timescale', '12288', a]);
  if (seconds <= pan) return fs.renameSync(a, out);
  await ffmpeg(['-i', image, '-vf', 'scale=1440:-2,crop=1280:720:160:(ih-720)/2', '-frames:v', '1', '-q:v', '3', tail]);
  const step = 20;
  const n = Math.ceil((seconds - pan) / step);
  const list = `${base}.list.txt`;
  fs.writeFileSync(list, Array.from({ length: n }, () => `file '${tail.replace(/'/g, "'\\''")}'\nduration ${step}\n`).join('') + `file '${tail.replace(/'/g, "'\\''")}'\n`);
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-fps_mode', 'vfr', '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-g', '6', '-video_track_timescale', '12288', b]);
  const list2 = `${base}.list2.txt`;
  fs.writeFileSync(list2, `file '${a.replace(/'/g, "'\\''")}'\nfile '${b.replace(/'/g, "'\\''")}'\n`);
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list2, '-c', 'copy', '-movflags', '+faststart', out]);
  for (const f of [a, b, tail, list, list2]) fs.rmSync(f, { force: true });
}

/** Short clip with a soft chord (trailers, extras). */
function clip(image, seconds, out, root = 220) {
  const chord = `aevalsrc='0.06*(sin(2*PI*${root}*t)+sin(2*PI*${root * 1.26}*t)+sin(2*PI*${root * 1.5}*t))*min(1,t/2)*min(1,(${seconds}-t)/2)':s=44100:d=${seconds}`;
  return ffmpeg(['-loop', '1', '-framerate', '24', '-i', image, '-f', 'lavfi', '-i', chord, '-t', String(seconds), '-vf', `scale=1600:-2,crop=1280:720:x='(iw-1280)*t/${seconds}':y='(ih-720)/2',format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', out]);
}

/** A synthesised track with a steady beat, bass line and pads, so tempo and key detection have something real. */
function track(out, { bpm, rootHz, seconds, style, tags }) {
  const B = (60 / bpm).toFixed(6);
  const bar = `mod(floor(t/(4*${B})),4)`;
  const M = `if(eq(${bar},0),1,if(eq(${bar},1),0.7937,if(eq(${bar},2),1.1892,0.8909)))`;
  const R = rootHz.toFixed(3);
  const x = `mod(t,${B})`;
  const kick = `0.55*sin(2*PI*(48*${x}+4.8*(1-exp(-25*${x}))))*exp(-7*${x})`;
  const hat = `0.10*(random(0)*2-1)*exp(-80*mod(t+${B}/2,${B}))`;
  const snare = `0.18*(random(1)*2-1)*exp(-22*mod(t+${B},2*${B}))`;
  const bass = `0.22*sin(2*PI*${R}*${M}*t)*(0.6+0.4*exp(-4*mod(t,${B}/2)))`;
  const pad = `0.05*(sin(2*PI*${R}*${M}*2*t)+sin(2*PI*${R}*${M}*2.3784*t)+sin(2*PI*${R}*${M}*2.9966*t))`;
  const arp = `0.05*sin(2*PI*${R}*${M}*4*pow(1.4983,mod(floor(t/(${B}/2)),3))*t)*exp(-6*mod(t,${B}/2))`;
  const parts = { synthwave: [kick, snare, bass, pad, arp, hat], lofi: [kick.replace('0.55', '0.4'), snare.replace('0.18', '0.12'), bass, pad, hat.replace('0.10', '0.05')], house: [kick, hat, bass, pad, arp], techno: [kick.replace('0.55', '0.65'), hat, bass.replace('0.22', '0.18'), arp] }[style];
  const env = `min(1,t/2)*min(1,(${seconds}-t)/3)`;
  const expr = `0.62*(${parts.join('+')})*${env}`;
  const meta = Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
  return ffmpeg(['-f', 'lavfi', '-i', `aevalsrc='${expr}':s=44100:d=${seconds}`, ...meta, '-c:a', 'libmp3lame', '-b:a', '128k', out]);
}

function nfoPeople(cast, base) {
  return cast.map((c, i) => `  <actor><name>${xml(c.name)}</name><role>${xml(c.role)}</role><order>${i}</order><thumb>${base}/people/${slug(c.name)}.jpg</thumb></actor>`).join('\n');
}

function movieNfo(m, base) {
  const month = String((m.slug.length % 12) + 1).padStart(2, '0');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>${xml(m.title)}</title>
  <year>${m.year}</year>
  <premiered>${m.year}-${month}-${String((m.title.length % 27) + 1).padStart(2, '0')}</premiered>
  <tagline>${xml(m.tagline)}</tagline>
  <plot>${xml(m.plot)}</plot>
  <runtime>${m.runtime}</runtime>
  <mpaa>${m.mpaa}</mpaa>
  <ratings><rating name="default" max="10" default="true"><value>${m.rating}</value></rating></ratings>
${m.genres.map((g) => `  <genre>${g}</genre>`).join('\n')}
  <studio>${xml(m.studio)}</studio>
  <director>${xml(m.director)}</director>
${m.writers.map((w) => `  <credits>${xml(w)}</credits>`).join('\n')}
${nfoPeople(m.cast, base)}
</movie>
`;
}

function showNfo(s, base) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<tvshow>
  <title>${xml(s.title)}</title>
  <year>${s.year}</year>
  <premiered>${s.year}-09-14</premiered>
  <tagline>${xml(s.tagline)}</tagline>
  <plot>${xml(s.plot)}</plot>
  <mpaa>${s.mpaa}</mpaa>
  <ratings><rating name="default" max="10" default="true"><value>${s.rating}</value></rating></ratings>
${s.genres.map((g) => `  <genre>${g}</genre>`).join('\n')}
  <studio>${xml(s.studio)}</studio>
${nfoPeople(s.cast, base)}
</tvshow>
`;
}

/**
 * Generate everything. `renderer` is an artwork Renderer; `assetBase` is the URL the mock server serves
 * `assets/` from (used for cast headshots in NFOs).
 */
export async function generateMedia({ root, renderer, assetBase, log }) {
  const media = path.join(root, 'media');
  const assets = path.join(root, 'assets');
  const art = path.join(root, 'art');
  const jobs = []; // ffmpeg work, run in a pool once the artwork exists
  const R = (html, w, h, out, q) => renderer.render(html, w, h, out, q);

  // People
  for (const p of PEOPLE) await R(A.headshotHtml(p), 400, 600, path.join(assets, 'people', `${slug(p)}.jpg`), 84);

  // Movies
  for (const m of MOVIES) {
    const name = `${safe(m.title)} (${m.year})`;
    const dir = path.join(media, 'Movies', name);
    fs.mkdirSync(dir, { recursive: true });
    await R(A.posterHtml(m), 800, 1200, path.join(dir, 'poster.jpg'));
    await R(A.backdropHtml(m), 1920, 1080, path.join(dir, 'fanart.jpg'));
    if (m.logo) await R(A.logoHtml(m), 1000, 400, path.join(dir, 'logo.png'));
    fs.writeFileSync(path.join(dir, 'movie.nfo'), movieNfo(m, assetBase));
    const still = path.join(art, `${m.slug}-still.jpg`);
    await R(A.backdropHtml(m, { seed: '-still', focusX: 0.55 }), 1920, 1080, still);
    jobs.push(() => longVideo(path.join(dir, 'fanart.jpg'), m.runtime * 60, path.join(dir, `${name}.mp4`)));
    if (m.trailer) jobs.push(() => clip(path.join(dir, 'fanart.jpg'), 30, path.join(dir, `${name}-trailer.mp4`), 196 + (m.year % 7) * 20));
    if (m.featurette) {
      fs.mkdirSync(path.join(dir, 'Featurettes'), { recursive: true });
      jobs.push(() => clip(still, 18, path.join(dir, 'Featurettes', 'Building the Meridian Spire.mp4'), 262));
      jobs.push(() => clip(path.join(dir, 'fanart.jpg'), 16, path.join(dir, 'Featurettes', 'The Sound of the City.mp4'), 294));
    }
    if (m.deleted) {
      fs.mkdirSync(path.join(dir, 'Deleted Scenes'), { recursive: true });
      jobs.push(() => clip(still, 14, path.join(dir, 'Deleted Scenes', 'Rooftop Chase (Extended).mp4'), 220));
    }
  }

  // TV
  for (const s of SHOWS) {
    const dir = path.join(media, 'TV', `${safe(s.title)} (${s.year})`);
    fs.mkdirSync(dir, { recursive: true });
    await R(A.posterHtml(s, { tv: true }), 800, 1200, path.join(dir, 'poster.jpg'));
    await R(A.backdropHtml(s), 1920, 1080, path.join(dir, 'fanart.jpg'));
    if (s.logo) await R(A.logoHtml(s), 1000, 400, path.join(dir, 'logo.png'));
    fs.writeFileSync(path.join(dir, 'tvshow.nfo'), showNfo(s, assetBase));
    for (let season = 1; season <= 2; season++) {
      const sdir = path.join(dir, `Season 0${season}`);
      fs.mkdirSync(sdir, { recursive: true });
      await R(A.posterHtml({ ...s, pal: season === 2 ? [s.pal[0], s.pal[2], s.pal[3], s.pal[1]] : s.pal }, { tv: true, seed: `-s${season}`, badge: `Season ${season}`, label: '' }), 800, 1200, path.join(dir, `season0${season}-poster.jpg`));
      for (let e = 1; e <= 3; e++) {
        const [title, plot] = s.seasons[(season - 1) * 3 + (e - 1)];
        const base = `${safe(s.title)} - S0${season}E0${e} - ${safe(title)}`;
        const thumb = path.join(sdir, `${base}-thumb.jpg`);
        await R(A.backdropHtml(s, { seed: `-ep${season}${e}`, focusX: 0.3 + ((season * 3 + e) % 5) * 0.12 }), 1280, 720, thumb, 84);
        const aired = new Date(Date.UTC(s.year + season - 1, 8, 14 + (e - 1) * 7)).toISOString().slice(0, 10);
        fs.writeFileSync(path.join(sdir, `${base}.nfo`), `<?xml version="1.0" encoding="UTF-8"?>\n<episodedetails>\n  <title>${xml(title)}</title>\n  <season>${season}</season>\n  <episode>${e}</episode>\n  <plot>${xml(plot)}</plot>\n  <aired>${aired}</aired>\n  <runtime>${s.runtimeEp}</runtime>\n</episodedetails>\n`);
        jobs.push(() => longVideo(thumb, (s.runtimeEp + ((e * 7) % 5)) * 60, path.join(sdir, `${base}.mp4`)));
      }
    }
  }

  // Music
  for (const a of ALBUMS) {
    const adir = path.join(media, 'Music', safe(a.artist));
    const dir = path.join(adir, safe(a.album));
    fs.mkdirSync(dir, { recursive: true });
    await R(A.albumCoverHtml(a), 1000, 1000, path.join(dir, 'cover.jpg'));
    await R(A.artistHtml(a), 1000, 1000, path.join(adir, 'folder.jpg'));
    await R(A.artistHtml(a, true), 1920, 1080, path.join(adir, 'fanart.jpg'));
    const keys = [0, 7, 5, 2, 9, 4];
    a.tracks.forEach((t, i) => {
      const bpm = a.bpm + [0, 2, -1, 1, 3, -2][i];
      jobs.push(() => track(path.join(dir, `${String(i + 1).padStart(2, '0')} - ${safe(t)}.mp3`), {
        bpm, rootHz: a.root * Math.pow(2, keys[i] / 12) * (keys[i] > 6 ? 0.5 : 1), seconds: 52 + ((i * 11) % 17), style: a.style,
        tags: { title: t, artist: a.artist, album_artist: a.artist, album: a.album, track: `${i + 1}/${a.tracks.length}`, date: String(a.year), genre: a.genre },
      }));
    });
  }

  // Audiobooks
  for (const b of AUDIOBOOKS) {
    const dir = path.join(media, 'Audiobooks', safe(b.author), safe(b.title));
    fs.mkdirSync(dir, { recursive: true });
    await R(A.audiobookHtml(b), 1000, 1000, path.join(dir, 'cover.jpg'));
    for (let c = 1; c <= b.chapters; c++) {
      const mins = 24 + ((c * 13) % 15);
      jobs.push(() => ffmpeg(['-f', 'lavfi', '-i', `anoisesrc=color=brown:amplitude=0.04:d=${mins * 60}`, '-ac', '1', '-ar', '22050', '-metadata', `title=Chapter ${c}`, '-metadata', `album=${b.title}`, '-metadata', `artist=${b.author}`, '-metadata', `album_artist=${b.author}`, '-metadata', `composer=${b.narrator}`, '-metadata', `track=${c}`, '-metadata', `date=${b.year}`, '-metadata', 'genre=Audiobook', '-c:a', 'libmp3lame', '-b:a', '16k', path.join(dir, `${String(c).padStart(2, '0')} - Chapter ${c}.mp3`)]));
    }
  }

  // Photos
  for (const [album, name, tod] of PHOTOS) await R(A.photoHtml(name, tod, album.startsWith('Coastal')), 1600, 1067, path.join(media, 'Photos', album, `${name}.jpg`), 86);

  // Live TV assets: logos, stream clips (the movie channel shows a feature's backdrop)
  for (const ch of CHANNELS) {
    await R(A.channelLogoHtml(ch), 400, 240, path.join(assets, 'logos', `${ch.id}.png`));
    const movie = MOVIES[ch.id % MOVIES.length];
    const extras = ch.kind === 'movies' ? { html: A.backdropHtml(MOVIES[4]) } : ch.kind === 'comedy' ? { html: A.backdropHtml(SHOWS[2]) } : ch.kind === 'science' ? { html: A.backdropHtml(MOVIES[1]) } : ch.kind === 'travel' ? { html: A.photoHtml('travel', 'day', true) } : ch.kind === 'lifestyle' ? { html: A.backdropHtml(MOVIES[8]) } : { style: movie.style, pal: movie.pal };
    const frame = path.join(art, `ch-${ch.id}.jpg`);
    await R(A.channelFrameHtml(ch, extras), 1280, 720, frame, 86);
    jobs.push(() => ffmpeg(['-loop', '1', '-framerate', '25', '-i', frame, '-f', 'lavfi', '-i', `sine=frequency=${180 + (ch.id % 10) * 30}:sample_rate=48000`, '-t', '90', '-vf', "scale=1280:720,zoompan=z='1+0.0004*on':d=1:s=1280x720:fps=25,format=yuv420p", '-af', 'volume=0.08', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-g', '50', '-c:a', 'aac', '-b:a', '64k', '-f', 'mpegts', path.join(assets, 'streams', `${ch.id}.ts`)]));
  }
  fs.mkdirSync(path.join(assets, 'streams'), { recursive: true });

  log(`Artwork done; encoding ${jobs.length} media files…`);
  let done = 0;
  await pool(jobs, 4, async (job) => {
    await job();
    if (++done % 20 === 0) log(`  ${done}/${jobs.length} encoded`);
  });
  return media;
}
