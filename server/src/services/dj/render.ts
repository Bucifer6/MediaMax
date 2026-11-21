/**
 * Server-side rendering of a DJ transition with ffmpeg: the same transitions the web DJ engine plays
 * (equal-power crossfade, EQ bass swap, filter fade, echo-out, tempo match with key lock) as one filter graph.
 *
 * Used by GET /dj/transition-preview (hear how two tracks will be mixed — handy for clients without Web Audio,
 * e.g. Cast receivers, and for checking a transition plan). Kinora does not otherwise render whole mixes on
 * the server: the web and mobile apps mix on the device.
 *
 * Tempo/key lock: `rubberband` (pitch-preserving time-stretch, librubberband) when this ffmpeg build has it,
 * else `atempo` — which is also pitch-preserving (WSOLA-style overlap-add, no resampling), just a little less
 * transparent on sustained tones. Neither changes the pitch, so the Camelot key check still holds.
 * Bass swap uses complementary 2× Butterworth low/high-pass splits (≈ 200 Hz) with per-band `volume` automation;
 * the filter fade sweeps a `highpass` cutoff with `asendcmd` (16 steps); echo-out is a beat-timed `aecho` tap
 * series (a 3/4-beat feedback delay, 0.55 feedback, unrolled into 8 taps) fed by the third quarter of the outgoing
 * track, whose dry signal is then cut on a beat. Levels per style match web/src/player/djMixer.ts.
 * Adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) — mixer levels per style from public/js/automix.js.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { DjTransition } from '@mediamax/shared';
import { config } from '../../config.js';

const filterCache = new Map<string, boolean>();
/** Does this ffmpeg build have a filter (e.g. rubberband)? Checked once per name. */
export function ffmpegHasFilter(name: string, ffmpeg = config.ffmpeg): boolean {
  const key = `${ffmpeg}|${name}`;
  const hit = filterCache.get(key);
  if (hit != null) return hit;
  let ok = false;
  try {
    const r = spawnSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 10000 });
    ok = new RegExp(`^\\s*[A-Z.|]{2,3}\\s+${name}\\s`, 'm').test(r.stdout ?? '');
  } catch {
    ok = false;
  }
  filterCache.set(key, ok);
  return ok;
}

export interface RenderPlan {
  /** Seek into A (ms) and how much of it to read. */
  aStartMs: number;
  aDurMs: number;
  /** Seek into B (ms, track time) and how much of it to read (track time). */
  bStartMs: number;
  bDurMs: number;
  /** Output length (ms). */
  totalMs: number;
  /** -filter_complex graph with inputs [0:a] (A) and [1:a] (B), output [out]. */
  graph: string;
  /** Which time-stretch filter was used ('none' when the tempo is untouched). */
  stretch: 'rubberband' | 'atempo' | 'none';
}

const f3 = (x: number) => (Math.round(x * 1000) / 1000).toString();

/** atempo accepts 0.5–100 per instance (older builds: 0.5–2); DJ ratios are within ±16 %, so one is enough. */
function tempoFilter(ratio: number, rubberband: boolean, label: string) {
  const r = (Math.round(ratio * 1e5) / 1e5).toString(); // 5 decimals: a 0.1 % error drifts 60 ms a minute
  return rubberband ? `rubberband@${label}=tempo=${r}:pitch=1:transients=crisp` : `atempo@${label}=${r}`;
}

/**
 * Build the ffmpeg filter graph for one transition.
 * leadMs = how much of A plays before the transition starts; tailMs = how much of B after it ends;
 * glideMs = after the transition, ease B's tempo back to 1.0 over this long (0 = stay at the matched tempo).
 */
export function buildTransitionGraph(t: DjTransition, opts: { leadMs?: number; tailMs?: number; glideMs?: number; rubberband?: boolean; sampleRate?: number } = {}): RenderPlan {
  const lead = Math.max(0, opts.leadMs ?? 8000) / 1000;
  const tail = Math.max(0, opts.tailMs ?? 8000) / 1000;
  const glide = Math.max(0, opts.glideMs ?? 0) / 1000;
  const sr = opts.sampleRate ?? 44100;
  const L = Math.max(0.3, t.crossfadeMs / 1000);
  const T0 = Math.min(lead, t.mixOutMs / 1000);
  const T1 = T0 + L;
  const total = T1 + tail;
  const ratio = t.style === 'blend' && t.tempoRatio > 0 ? t.tempoRatio : 1;
  const stretching = Math.abs(ratio - 1) > 0.0005;
  const stretch: RenderPlan['stretch'] = !stretching ? 'none' : opts.rubberband ? 'rubberband' : 'atempo';
  const fx = t.fx ?? 'none';
  const fmt = `aformat=sample_fmts=fltp:sample_rates=${sr}:channel_layouts=stereo`;
  const parts: string[] = [];
  const aLen = T1 + 0.05;
  // B's track time covered: transition at `ratio`, then the glide (average speed ≈ (ratio+1)/2), then 1.0.
  const glideLen = stretching ? Math.min(glide, tail) : 0;
  const bTrack = L * ratio + glideLen * ((ratio + 1) / 2) + (tail - glideLen) + 0.1;
  const v = (expr: string) => `volume=eval=frame:volume='${expr}'`;
  const fadeOut = `if(lt(t,${f3(T0)}),1,if(lt(t,${f3(T1)}),cos((t-${f3(T0)})/${f3(L)}*PI/2),0))`;
  const fadeIn = `if(lt(t,${f3(T0)}),0,if(lt(t,${f3(T1)}),sin((t-${f3(T0)})/${f3(L)}*PI/2),1))`;
  const XO = 200; // bass-swap crossover (Hz)

  // ---- A (outgoing) ----
  parts.push(`[0:a]${fmt},atrim=0:${f3(aLen)},asetpts=PTS-STARTPTS[a0]`);
  if (fx === 'bassSwap') {
    const S = T0 + Math.max(0, Math.min(L, (t.swapAtMs ?? t.crossfadeMs / 2) / 1000));
    parts.push(`[a0]asplit=2[al][ah]`);
    parts.push(`[al]lowpass=f=${XO},lowpass=f=${XO},${v(`if(lt(t,${f3(S)}),1,max(0,1-(t-${f3(S)})/0.08))`)}[alo]`);
    parts.push(`[ah]highpass=f=${XO},highpass=f=${XO},${v(fadeOut)}[ahi]`);
    parts.push(`[alo][ahi]amix=inputs=2:normalize=0[aout]`);
  } else if (fx === 'filter') {
    // High-pass sweep 20 Hz → 2.5 kHz over the first 90 % (exponential steps), volume out over the second half.
    const steps = 16;
    const cmds = Array.from({ length: steps + 1 }, (_, i) => `${f3(T0 + (i / steps) * 0.9 * L)} highpass@hpA f ${Math.round(20 * Math.pow(125, i / steps))}`);
    const half = T0 + L / 2;
    parts.push(`[a0]asendcmd=c='${cmds.join(';')}',highpass@hpA=f=20,${v(`if(lt(t,${f3(half)}),1,if(lt(t,${f3(T1)}),cos((t-${f3(half)})/${f3(L / 2)}*PI/2),0))`)}[aout]`);
  } else if (fx === 'echo') {
    // Feed the echo from the middle of the transition; cut the dry signal at ~3/4 (on a beat); 3/4-beat delay.
    const beat = Math.max(0.15, Math.min(1.2, (t.beatMs ?? 500) / 1000));
    const d = beat * 0.75;
    const sendOn = T0 + L * 0.5;
    const cut = T0 + Math.round((L * 0.75) / beat) * beat;
    const taps = 8;
    const delays = Array.from({ length: taps }, (_, i) => Math.round(d * 1000 * (i + 1))).join('|');
    const decays = Array.from({ length: taps }, (_, i) => f3(Math.pow(0.55, i + 1))).join('|');
    parts.push(`[a0]apad=pad_dur=${f3(d * taps + 0.5)},asplit=2[ad][aw]`);
    parts.push(`[ad]${v(`if(lt(t,${f3(cut)}),1,max(0,1-(t-${f3(cut)})/0.03))`)}[adry]`);
    parts.push(`[aw]${v(`if(between(t,${f3(sendOn)},${f3(cut)}),1,0)`)},aecho=0:1:${delays}:${decays}[awet]`);
    parts.push(`[adry][awet]amix=inputs=2:normalize=0[aout]`);
  } else {
    parts.push(`[a0]${v(fadeOut)}[aout]`);
  }

  // ---- B (incoming): tempo match with key lock, optional glide back to 1.0, delayed to T0 ----
  let bChain = `[1:a]${fmt},atrim=0:${f3(bTrack)},asetpts=PTS-STARTPTS`;
  if (stretching) {
    bChain += `,${tempoFilter(ratio, !!opts.rubberband, 'tb')}`;
    if (glideLen > 0) {
      // Commands run on B's own (stretched-input) clock: the transition covers L×ratio of B's track time.
      const steps = 12;
      const startIn = L * ratio;
      const target = opts.rubberband ? 'rubberband@tb tempo' : 'atempo@tb tempo';
      const cmds = Array.from({ length: steps }, (_, i) => {
        const x = (i + 1) / steps;
        return `${f3(startIn + glideLen * x * ((ratio + 1) / 2))} ${target} ${f3(ratio + (1 - ratio) * x)}`;
      });
      bChain = bChain.replace(`[1:a]${fmt},atrim=0:${f3(bTrack)},asetpts=PTS-STARTPTS`, `[1:a]${fmt},atrim=0:${f3(bTrack)},asetpts=PTS-STARTPTS,asendcmd=c='${cmds.join(';')}'`);
    }
  }
  const ms = Math.round(T0 * 1000);
  bChain += `,adelay=${ms}|${ms}`;
  parts.push(`${bChain}[b0]`);
  if (fx === 'bassSwap') {
    const S = T0 + Math.max(0, Math.min(L, (t.swapAtMs ?? t.crossfadeMs / 2) / 1000));
    parts.push(`[b0]asplit=2[bl][bh]`);
    parts.push(`[bl]lowpass=f=${XO},lowpass=f=${XO},${v(`if(lt(t,${f3(S)}),0,min(1,(t-${f3(S)})/0.08))`)}[blo]`);
    parts.push(`[bh]highpass=f=${XO},highpass=f=${XO},${v(fadeIn)}[bhi]`);
    parts.push(`[blo][bhi]amix=inputs=2:normalize=0[bout]`);
  } else if (fx === 'echo') {
    // The new track sneaks in under the echo (to 35 %), then drops in fully at the cut.
    const beat = Math.max(0.15, Math.min(1.2, (t.beatMs ?? 500) / 1000));
    const cut = T0 + Math.round((L * 0.75) / beat) * beat;
    const k = `min(1,max(0,(t-${f3(T0)})/${f3(Math.max(0.05, cut - T0))}))`;
    parts.push(`[b0]${v(`if(lt(t,${f3(cut)}),0.35*${k}*${k}*(3-2*${k}),min(1,0.35+(t-${f3(cut)})/0.03))`)}[bout]`);
  } else if (fx === 'filter') {
    // Ease in (smoothstep) over the first two thirds so the high-passed outgoing track leaves room.
    const k = `min(1,max(0,(t-${f3(T0)})/${f3(L * 0.66)}))`;
    parts.push(`[b0]${v(`${k}*${k}*(3-2*${k})`)}[bout]`);
  } else {
    parts.push(`[b0]${v(fadeIn)}[bout]`);
  }
  // Sample-count timestamps on both branches (aecho/apad tails can leave gaps), then trim by samples.
  parts.push(`[aout]asetpts=N/SR/TB[aoutn]`);
  parts.push(`[bout]asetpts=N/SR/TB[boutn]`);
  parts.push(`[aoutn][boutn]amix=inputs=2:normalize=0:duration=longest,atrim=end_sample=${Math.round(total * sr)},alimiter=limit=0.97:level=disabled[out]`);
  return {
    aStartMs: Math.max(0, Math.round(t.mixOutMs - T0 * 1000)), aDurMs: Math.round(aLen * 1000 + (fx === 'echo' ? 8000 : 0)),
    bStartMs: Math.max(0, Math.round(t.mixInMs)), bDurMs: Math.round(bTrack * 1000),
    totalMs: Math.round(total * 1000), graph: parts.join(';'), stretch,
  };
}

/** ffmpeg arguments that render a plan from two files to `out` (format from the extension, or '-' + format). */
export function renderArgs(aFile: string, bFile: string, plan: RenderPlan, out: string, format: 'mp3' | 'wav' = 'mp3'): string[] {
  return [
    '-v', 'error', '-nostdin', '-y',
    '-ss', f3(plan.aStartMs / 1000), '-t', f3(plan.aDurMs / 1000), '-i', aFile,
    '-ss', f3(plan.bStartMs / 1000), '-t', f3(plan.bDurMs / 1000), '-i', bFile,
    '-filter_complex', plan.graph, '-map', '[out]',
    ...(format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3'] : ['-c:a', 'pcm_s16le', '-f', 'wav']),
    out,
  ];
}

/** Render a transition to a file. */
export function renderTransition(aFile: string, bFile: string, plan: RenderPlan, out: string, format: 'mp3' | 'wav' = 'mp3', ffmpeg = config.ffmpeg): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, renderArgs(aFile, bFile, plan, out, format), { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d).slice(-800)));
    const timer = setTimeout(() => p.kill('SIGKILL'), 120000);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `ffmpeg exited with ${code}`));
    });
  });
}
