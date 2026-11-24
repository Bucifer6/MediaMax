import sax from 'sax';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { PassThrough, Readable, pipeline } from 'node:stream';

export interface XmltvChannel {
  id: string;
  names: string[];
  icon: string | null;
  /** <lcn> logical channel number, when present. */
  number?: string | null;
}

export interface XmltvProgramme {
  channel: string;
  start: string;
  end: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  category: string | null;
  icon: string | null;
  episodeNum: string | null;
  isNew: boolean;
}

/** Offset (ms) of an IANA zone from UTC at a given instant. */
function zoneOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs));
  const v = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second')) - Math.floor(utcMs / 1000) * 1000;
}

/** True for an IANA zone name ("Europe/London") or a fixed offset ("+01:00", "-0500", "UTC"). */
export function isValidTimezone(tz: string): boolean {
  if (/^(?:[+-]\d{2}:?\d{2}|Z|UTC|GMT)$/i.test(tz.trim())) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock time in a zone → UTC ms. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const fixed = tz.trim().match(/^([+-])(\d{2}):?(\d{2})$/);
  if (fixed) return wall - (fixed[1] === '-' ? -1 : 1) * (Number(fixed[2]) * 60 + Number(fixed[3])) * 60000;
  if (/^(Z|UTC|GMT)$/i.test(tz.trim())) return wall;
  let utc = wall - zoneOffsetMs(wall, tz);
  const again = wall - zoneOffsetMs(utc, tz);
  if (again !== utc) utc = again;
  return utc;
}

/**
 * XMLTV time "20240101123000 +0100" → ISO. With `tzOverride`, the offset in the file is ignored and the
 * wall-clock time is read in that zone instead (for guides published with the wrong time zone).
 */
export function parseXmltvTime(s: string, tzOverride?: string | null): string | null {
  const m = s.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{2}:?\d{2}|Z)?/);
  if (!m) return null;
  const [, Y, M, D, h, mi, sec = '00', tz] = m;
  if (tzOverride) {
    const ms = zonedToUtc(+Y, +M, +D, +h, +mi, +sec, tzOverride);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  let iso = `${Y}-${M}-${D}T${h}:${mi}:${sec}`;
  if (!tz || tz === 'Z') iso += 'Z';
  else iso += tz.length === 5 ? `${tz.slice(0, 3)}:${tz.slice(3)}` : tz;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Sniff gzip / xz magic bytes and decompress transparently (xz needs the `xz` tool on PATH). */
export async function autoDecompress(src: Readable): Promise<Readable> {
  const it = src[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) return Readable.from([]);
  const head = Buffer.isBuffer(first.value) ? first.value : Buffer.from(first.value);
  const rest = Readable.from((async function* () {
    yield head;
    for (;;) {
      const n = await it.next();
      if (n.done) return;
      yield n.value;
    }
  })());
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const gz = createGunzip();
    return pipeline(rest, gz, (e) => e && gz.destroy(e)) as unknown as Readable;
  }
  if (head.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))) {
    const out = new PassThrough();
    const xz = spawn('xz', ['-dc'], { stdio: ['pipe', 'pipe', 'ignore'] });
    xz.on('error', () => out.destroy(new Error('This guide is .xz compressed and the xz tool is not installed')));
    xz.on('close', (code) => code && out.destroy(new Error(`xz failed (exit ${code})`)));
    xz.stdin.on('error', () => undefined);
    // A download that fails mid-way (or a reader that gives up) never ends xz's stdin: stop xz rather than leave it waiting.
    rest.on('error', (e) => {
      xz.kill();
      out.destroy(e);
    });
    out.on('close', () => {
      if (xz.exitCode === null && xz.signalCode === null) xz.kill();
      rest.destroy();
    });
    rest.pipe(xz.stdin);
    xz.stdout.pipe(out);
    return out;
  }
  return rest;
}

/** Open an XMLTV guide from an http(s) URL or a local file path, decompressing gzip/xz. */
export async function openXmltv(input: string, opts: { userAgent?: string | null; timeoutMs?: number } = {}): Promise<Readable> {
  if (/^https?:\/\//i.test(input)) {
    const res = await fetch(input, { headers: { 'User-Agent': opts.userAgent || 'Kinora/1.0', 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 300000) }).catch((e: any) => {
      throw new Error(`Could not download the guide: ${e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e}`);
    });
    if (!res.ok || !res.body) throw new Error(`EPG download failed: HTTP ${res.status}`);
    return autoDecompress(Readable.fromWeb(res.body as any));
  }
  const file = input.replace(/^file:\/\//i, '');
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st?.isFile()) throw new Error(`Guide file not found: ${file}`);
  return autoDecompress(fs.createReadStream(file));
}

/**
 * Streams an XMLTV document (optionally gzipped) and calls back per channel/programme.
 * Memory use stays flat even for very large guides.
 */
export function parseXmltvReadable(stream: NodeJS.ReadableStream, opts: { onChannel: (c: XmltvChannel) => void; onProgramme: (p: XmltvProgramme) => void; timezone?: string | null }): Promise<{ channels: number; programmes: number }> {
  return new Promise((resolve, reject) => {
    const parser = sax.createStream(false, { lowercase: true, trim: true });
    let channels = 0;
    let programmes = 0;
    let curChan: XmltvChannel | null = null;
    let curProg: Partial<XmltvProgramme> | null = null;
    let textTarget: string | null = null;
    let text = '';
    parser.on('opentag', (node) => {
      const a = node.attributes as Record<string, string>;
      if (node.name === 'channel') curChan = { id: a.id ?? '', names: [], icon: null };
      else if (node.name === 'programme') {
        curProg = { channel: a.channel ?? '', start: parseXmltvTime(a.start ?? '', opts.timezone) ?? '', end: parseXmltvTime(a.stop ?? '', opts.timezone) ?? '', title: '', subtitle: null, description: null, category: null, icon: null, episodeNum: null, isNew: false };
      } else if (node.name === 'icon') {
        if (curProg) curProg.icon = a.src ?? null;
        else if (curChan) curChan.icon = a.src ?? null;
      } else if (node.name === 'new' && curProg) curProg.isNew = true;
      else if (node.name === 'episode-num' && curProg) {
        textTarget = a.system === 'onscreen' || !curProg.episodeNum ? `episode:${a.system ?? ''}` : null;
        text = '';
      } else if (['display-name', 'title', 'sub-title', 'desc', 'category', 'lcn'].includes(node.name)) {
        textTarget = node.name;
        text = '';
      }
    });
    parser.on('text', (t) => {
      if (textTarget) text += t;
    });
    parser.on('cdata', (t) => {
      if (textTarget) text += t;
    });
    parser.on('closetag', (name) => {
      if (textTarget && (name === textTarget || (name === 'episode-num' && textTarget.startsWith('episode:')))) {
        const v = text.trim();
        if (curChan && name === 'display-name' && v) curChan.names.push(v);
        if (curChan && name === 'lcn' && v) curChan.number = v;
        if (curProg) {
          if (name === 'title' && !curProg.title) curProg.title = v;
          else if (name === 'sub-title') curProg.subtitle = v || null;
          else if (name === 'desc' && !curProg.description) curProg.description = v || null;
          else if (name === 'category' && !curProg.category) curProg.category = v || null;
          else if (name === 'episode-num') curProg.episodeNum = formatEpisodeNum(v, textTarget.slice(8));
        }
        textTarget = null;
      }
      if (name === 'channel' && curChan) {
        channels++;
        opts.onChannel(curChan);
        curChan = null;
      } else if (name === 'programme' && curProg) {
        if (curProg.channel && curProg.start && curProg.end && curProg.title) {
          programmes++;
          opts.onProgramme(curProg as XmltvProgramme);
        }
        curProg = null;
      }
    });
    parser.on('error', function (this: any, e: Error) {
      // Tolerate malformed documents: clear the error and keep going.
      this._parser.error = null;
      this._parser.resume();
      void e;
    });
    parser.on('end', () => resolve({ channels, programmes }));
    stream.on('error', reject);
    stream.pipe(parser);
  });
}

function formatEpisodeNum(v: string, system: string): string | null {
  if (!v) return null;
  if (system === 'xmltv_ns') {
    const [s, e] = v.split('.').map((x) => x.split('/')[0].trim());
    const sn = s !== '' && !Number.isNaN(+s) ? +s + 1 : null;
    const en = e !== '' && !Number.isNaN(+e) ? +e + 1 : null;
    if (sn !== null && en !== null) return `S${String(sn).padStart(2, '0')}E${String(en).padStart(2, '0')}`;
    if (en !== null) return `E${en}`;
    return null;
  }
  return v;
}
