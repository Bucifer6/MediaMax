/**
 * ffmpeg and eSpeak NG helpers for the review pack: generated films with a title card and a synthesised score,
 * calibration tones, live test-channel loops and spoken-word audio. Every picture comes from ffmpeg's built-in
 * test sources (gradients, life, cellauto, mandelbrot, zoneplate, smptehdbars, testsrc2) and every sound from
 * maths or a speech synthesiser: nothing is sampled from existing works.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { renderTrack, writeWav } from './opendj-synth.mjs';

export const FFMPEG = process.env.KINORA_FFMPEG || process.env.MEDIAMAX_FFMPEG || 'ffmpeg';
export const ESPEAK = process.env.ESPEAK || 'espeak-ng';

export function ff(args, { quiet = true } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...args], { stdio: ['ignore', quiet ? 'ignore' : 'inherit', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err.slice(-600)}\nffmpeg ${args.join(' ')}`))));
  });
}

export function probe(file) {
  const r = spawnSync(FFMPEG.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'), ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,channels,color_transfer', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const hex = (c) => c.replace('#', '0x');
const rgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
/** lutrgb that maps black→c0 and white→c1 (for grey test sources). */
const duotone = (c0, c1) => {
  const [a, b] = [rgb(c0), rgb(c1)];
  return `lutrgb=r='${a[0]}+(${b[0] - a[0]})*val/255':g='${a[1]}+(${b[1] - a[1]})*val/255':b='${a[2]}+(${b[2] - a[2]})*val/255'`;
};

/**
 * One lavfi input (as ffmpeg args) for a visual at w×h (the 4K HDR film is drawn at 1280×720 and scaled up after
 * the colour conversion, which keeps the build to minutes on a laptop).
 */
function visualInput(v, w, h, fps, seconds) {
  const s = `${w}x${h}`;
  const t = ['-t', String(seconds)];
  switch (v.kind) {
    case 'gradients':
      return [...t, '-f', 'lavfi', '-i', `gradients=s=${s}:r=${fps}:${v.colors.map((c, i) => `c${i}=${hex(c)}`).join(':')}:nb_colors=${v.colors.length}:type=${v.type}:speed=${v.speed}:seed=7`];
    case 'life':
      return [...t, '-f', 'lavfi', '-i', `life=s=${Math.round(w / 4)}x${Math.round(h / 4)}:r=12:ratio=0.12:mold=${v.mold}:life_color=${hex(v.life)}:death_color=${hex(v.death)}:mold_color=${hex(v.death)}:seed=42,scale=${w}:${h}:flags=neighbor,fps=${fps}`];
    case 'cellauto':
      return [...t, '-f', 'lavfi', '-i', `cellauto=s=${Math.round(w / 4)}x${Math.round(h / 4)}:rule=${v.rule}:r=${fps}:scroll=1:seed=11,scale=${w}:${h}:flags=neighbor,format=rgb24,${duotone(v.colors[0], v.colors[1])}`];
    case 'mandelbrot':
      return [...t, '-f', 'lavfi', '-i', `mandelbrot=s=${s}:r=${fps}:maxiter=400:start_scale=3:end_scale=0.02:end_pts=${seconds * fps}:start_x=-0.743643887037158704752191506114774:start_y=-0.131825904205311970493132056385139:outer=normalized_iteration_count:inner=period`];
    case 'zoneplate':
      // Gentle settings: few, slow-moving rings (no strobing).
      return [...t, '-f', 'lavfi', '-i', `zoneplate=s=${s}:r=${fps}:precision=10:kx2=36:ky2=36:kt2=6,format=rgb24,${duotone('#120b24', '#7ee0ff')}`];
    default:
      throw new Error(`Unknown visual ${v.kind}`);
  }
}

/** Renders a synthesised track (opendj-synth) to WAV and returns its path. */
export function synthWav(def, out) {
  const audio = renderTrack({ genre: 'Electronic', year: 2026, ...def });
  writeWav(out, audio);
  return { file: out, seconds: audio.seconds };
}

const HDR_PARAMS = 'log-level=error:hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400';

/**
 * A generated film: visual + transparent title card for the first seconds + score (WAV) or test tones.
 * codec 'h264' → H.264 High / AAC stereo MP4; 'hevc-hdr10' → HEVC Main 10 HDR10 (BT.2020 / PQ with mastering
 * metadata) at w×h, optionally with 5.1 AAC.
 */
export async function makeFilm({ out, w, h, fps, seconds, visual, titlePng, audioWav, codec = 'h264', surround = false, tmp }) {
  const hdr = codec === 'hevc-hdr10';
  const [vw, vh] = hdr ? [1280, 720] : [w, h];
  const inputs = [];
  let vchain;
  if (visual.kind === 'calibration') {
    // 25 s SMPTE HD bars, 25 s moving test card, 10 s gentle zone plate.
    const a = Math.round(seconds * 0.42), b = Math.round(seconds * 0.42), c = seconds - a - b;
    inputs.push('-t', String(a), '-f', 'lavfi', '-i', `smptehdbars=s=${vw}x${vh}:r=${fps}`, '-t', String(b), '-f', 'lavfi', '-i', `testsrc2=s=${vw}x${vh}:r=${fps}`);
    inputs.push(...visualInput({ kind: 'zoneplate' }, vw, vh, fps, c));
    vchain = `[0:v]format=yuv420p[a0];[1:v]format=yuv420p[a1];[2:v]format=yuv420p[a2];[a0][a1][a2]concat=n=3:v=1:a=0,format=rgb24[bg]`;
  } else {
    inputs.push(...visualInput(visual, vw, vh, fps, seconds));
    vchain = `[0:v]format=rgb24[bg]`;
  }
  const nVideo = visual.kind === 'calibration' ? 3 : 1;
  inputs.push('-loop', '1', '-t', String(seconds), '-i', titlePng);
  const tIdx = nVideo;
  let aIdx = nVideo + 1;
  if (audioWav) inputs.push('-i', audioWav);
  else {
    // Calibration: 1 kHz at −18 dBFS under the bars, a slow sweep under the test card, silence after.
    const a = Math.round(seconds * 0.42), b = Math.round(seconds * 0.42);
    inputs.push('-f', 'lavfi', '-i', `aevalsrc='if(lt(t,${a}),0.126*sin(2*PI*1000*t),if(lt(t,${a + b}),0.1*sin(2*PI*(100*pow(80,(t-${a})/${b}))*${b}/log(80)),0))':s=48000:d=${seconds}`);
  }
  const fadeOut = Math.max(0, seconds - 1.5);
  let graph = `${vchain};[${tIdx}:v]format=rgba,scale=${vw}:${vh},fade=t=in:st=0.4:d=0.8:alpha=1,fade=t=out:st=5:d=1:alpha=1[tc];[bg][tc]overlay=0:0:shortest=1,fade=t=in:st=0:d=0.6,fade=t=out:st=${fadeOut}:d=1.5`;
  if (hdr) graph += `,format=yuv444p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt2020,zscale=t=smpte2084:m=bt2020nc:r=tv:npl=100,format=yuv420p10le,scale=${w}:${h}:flags=bicubic[v]`;
  else graph += `,format=yuv420p[v]`;
  const pan = surround ? ',pan=5.1|FL=FL|FR=FR|FC=0.5*FL+0.5*FR|LFE=0.25*FL+0.25*FR|BL=0.6*FL|BR=0.6*FR' : '';
  graph += `;[${aIdx}:a]atrim=0:${seconds},asetpts=N/SR/TB,afade=t=in:st=0:d=1,afade=t=out:st=${Math.max(0, seconds - 2.5)}:d=2.5,aresample=48000${pan}[a]`;
  const venc = hdr
    ? ['-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '20', '-tag:v', 'hvc1', '-x265-params', HDR_PARAMS, '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc']
    // Capped so detailed generators (the Mandelbrot zoom) don't balloon the pack.
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', w >= 1920 ? '6M' : w >= 1280 ? '3M' : '1500k', '-bufsize', w >= 1920 ? '12M' : w >= 1280 ? '6M' : '3M', '-profile:v', 'high', '-g', String(fps * 2), '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];
  const aenc = ['-c:a', 'aac', '-b:a', surround ? '384k' : '192k', ...(surround ? [] : ['-ac', '2'])];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await ff([...inputs, '-filter_complex', graph, '-map', '[v]', '-map', '[a]', ...venc, ...aenc, '-t', String(seconds), '-metadata', 'comment=Generated by the Kinora review pack. CC0 1.0.', '-movflags', '+faststart', `${out}.part.mp4`]);
  fs.renameSync(`${out}.part.mp4`, out); // only a finished file counts as done when a build is resumed
  void tmp;
  return out;
}

/** A 60 s live test-channel loop (MPEG-TS, H.264/AAC) from a still frame with a running clock and a quiet tone. */
export async function makeChannelLoop({ frame, out, seconds = 60, toneHz = 440, visual }) {
  // The still is panned slowly so the picture visibly moves; ffmpeg's own testsrc2 corner shows a running timer.
  const overlay = visual === 'testcard' ? `[1:v]scale=320:180[clock];[bg][clock]overlay=W-w-48:H-h-44` : `[bg]null`;
  await ff([
    '-loop', '1', '-framerate', '25', '-t', String(seconds), '-i', frame,
    '-f', 'lavfi', '-t', String(seconds), '-i', 'testsrc2=s=320x180:r=25',
    '-f', 'lavfi', '-t', String(seconds), '-i', `aevalsrc='0.05*sin(2*PI*${toneHz}*t)*(0.6+0.4*sin(2*PI*0.25*t))':s=48000`,
    '-filter_complex', `[0:v]scale=1408:-2,crop=1280:720:x='(iw-1280)*(0.5+0.5*sin(2*PI*t/${seconds}))':y='(ih-720)/2',format=yuv420p[bg];${overlay},format=yuv420p[v]`,
    '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-f', 'mpegts', `${out}.part`,
  ]);
  fs.renameSync(`${out}.part`, out);
  return out;
}

/** Text → WAV with eSpeak NG (GPL-3.0 program; the audio it produces is not covered by its licence). */
export function speak(text, out, { voice = 'en-gb', speed = 150, pitch = 50 } = {}) {
  const r = spawnSync(ESPEAK, ['-v', voice, '-s', String(speed), '-p', String(pitch), '-w', out, text], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`espeak-ng failed: ${r.stderr || r.error?.message}. Install eSpeak NG (apt install espeak-ng / brew install espeak-ng).`);
  return out;
}

/** WAV files → one MP3 (mono speech) with tags, optional quiet music bed underneath. */
export async function speechMp3({ parts, out, tags, bed, gapSeconds = 0.45, bitrate = '64k' }) {
  const list = parts.flatMap((p, i) => (i ? [`file 'silence.wav'`] : []).concat([`file '${path.basename(p)}'`]));
  const dir = path.dirname(parts[0]);
  await ff(['-f', 'lavfi', '-t', String(gapSeconds), '-i', 'anullsrc=r=22050:cl=mono', path.join(dir, 'silence.wav')]);
  const listFile = path.join(dir, `${path.basename(out)}.txt`);
  fs.writeFileSync(listFile, list.join('\n') + '\n');
  const meta = Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
  const speech = ['-f', 'concat', '-safe', '0', '-i', listFile];
  if (bed) {
    await ff([...speech, '-i', bed, '-filter_complex', '[0:a]aresample=44100,pan=mono|c0=c0,apad=pad_dur=1.5[s];[1:a]aresample=44100,pan=mono|c0=0.5*c0+0.5*c1,volume=0.12[m];[s][m]amix=inputs=2:duration=first:normalize=0[a]', '-map', '[a]', ...meta, '-c:a', 'libmp3lame', '-b:a', bitrate, out]);
  } else {
    await ff([...speech, '-ac', '1', ...meta, '-c:a', 'libmp3lame', '-b:a', bitrate, out]);
  }
  fs.rmSync(listFile, { force: true });
  return out;
}

/** WAV → tagged MP3 with embedded cover. */
export function encodeTrack({ wav, cover, out, tags, bitrate = '192k' }) {
  const meta = Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
  return ff(['-i', wav, ...(cover ? ['-i', cover, '-map', '0:a', '-map', '1:v', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic'] : []), '-c:a', 'libmp3lame', '-b:a', bitrate, '-id3v2_version', '3', ...meta, out]);
}

/** Re-tag a downloaded MP3 without re-encoding the audio (drops any embedded picture, adds ours). */
export function retagMp3({ src, cover, out, tags }) {
  const meta = Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
  return ff(['-i', src, ...(cover ? ['-i', cover] : []), '-map', '0:a', ...(cover ? ['-map', '1:v', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic'] : []), '-c:a', 'copy', '-map_metadata', '-1', '-id3v2_version', '3', ...meta, out]);
}
