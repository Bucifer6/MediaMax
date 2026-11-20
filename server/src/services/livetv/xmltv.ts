import sax from 'sax';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';

export interface XmltvChannel {
  id: string;
  names: string[];
  icon: string | null;
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

/** XMLTV time "20240101123000 +0100" → ISO. */
export function parseXmltvTime(s: string): string | null {
  const m = s.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{2}:?\d{2}|Z)?/);
  if (!m) return null;
  const [, Y, M, D, h, mi, sec = '00', tz] = m;
  let iso = `${Y}-${M}-${D}T${h}:${mi}:${sec}`;
  if (!tz || tz === 'Z') iso += 'Z';
  else iso += tz.length === 5 ? `${tz.slice(0, 3)}:${tz.slice(3)}` : tz;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Streams an XMLTV document (optionally gzipped) and calls back per channel/programme.
 * Memory use stays flat even for very large guides.
 */
export async function parseXmltvStream(
  url: string,
  opts: { userAgent?: string | null; onChannel: (c: XmltvChannel) => void; onProgramme: (p: XmltvProgramme) => void; timeoutMs?: number },
): Promise<{ channels: number; programmes: number }> {
  const res = await fetch(url, { headers: { 'User-Agent': opts.userAgent || 'MediaMax/1.0', 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 300000) });
  if (!res.ok || !res.body) throw new Error(`EPG download failed: HTTP ${res.status}`);
  let stream: NodeJS.ReadableStream = Readable.fromWeb(res.body as any);
  const isGz = url.toLowerCase().split('?')[0].endsWith('.gz') || (res.headers.get('content-type') ?? '').includes('gzip');
  if (isGz && res.headers.get('content-encoding') !== 'gzip') stream = stream.pipe(createGunzip());
  return parseXmltvReadable(stream, opts);
}

export function parseXmltvReadable(stream: NodeJS.ReadableStream, opts: { onChannel: (c: XmltvChannel) => void; onProgramme: (p: XmltvProgramme) => void }): Promise<{ channels: number; programmes: number }> {
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
        curProg = { channel: a.channel ?? '', start: parseXmltvTime(a.start ?? '') ?? '', end: parseXmltvTime(a.stop ?? '') ?? '', title: '', subtitle: null, description: null, category: null, icon: null, episodeNum: null, isNew: false };
      } else if (node.name === 'icon') {
        if (curProg) curProg.icon = a.src ?? null;
        else if (curChan) curChan.icon = a.src ?? null;
      } else if (node.name === 'new' && curProg) curProg.isNew = true;
      else if (node.name === 'episode-num' && curProg) {
        textTarget = a.system === 'onscreen' || !curProg.episodeNum ? `episode:${a.system ?? ''}` : null;
        text = '';
      } else if (['display-name', 'title', 'sub-title', 'desc', 'category'].includes(node.name)) {
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
