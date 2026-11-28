/**
 * epgshare01 (https://epgshare01.online/epgshare01/): free XMLTV guides, one or more files per country
 * (epg_ripper_<CC><n>.xml.gz), each with a plain channel list next to it (epg_ripper_<CC><n>.txt, ids such as
 * `Antena.1.HD.ro`). It is the default guide: after a live source's channels sync, the server compares the channel
 * names with those lists, adds the files that carry them as guide sources (once; an admin who deletes them isn't
 * overruled) and the usual matcher links each channel to its guide channel. Admins can run it again from the guide
 * page (POST /livetv/epg-sources/auto).
 */
import type { EpgPreset } from '@mediamax/shared';
import { db } from '../../../db.js';
import { logger } from '../../../util/log.js';
import { getKv, setKv } from '../../settings.js';

const log = logger('epgshare');
export const EPGSHARE_BASE = 'https://epgshare01.online/epgshare01/';

/** Country files (as listed on the site, Nov 2026). */
const FILES: [file: string, country: string, name: string][] = [
  ['AE1', 'AE', 'United Arab Emirates'], ['AL1', 'AL', 'Albania'], ['AR1', 'AR', 'Argentina'], ['AT1', 'AT', 'Austria'], ['AU1', 'AU', 'Australia'],
  ['BA1', 'BA', 'Bosnia and Herzegovina'], ['BB1', 'BB', 'Barbados'], ['BE2', 'BE', 'Belgium'], ['BG1', 'BG', 'Bulgaria'], ['BR1', 'BR', 'Brazil'],
  ['BR2', 'BR', 'Brazil'], ['CA2', 'CA', 'Canada'], ['CH1', 'CH', 'Switzerland'], ['CL1', 'CL', 'Chile'], ['CO1', 'CO', 'Colombia'],
  ['CR1', 'CR', 'Costa Rica'], ['CY1', 'CY', 'Cyprus'], ['CZ1', 'CZ', 'Czechia'], ['DE1', 'DE', 'Germany'], ['DK1', 'DK', 'Denmark'],
  ['DO1', 'DO', 'Dominican Republic'], ['EC1', 'EC', 'Ecuador'], ['ES1', 'ES', 'Spain'], ['FI1', 'FI', 'Finland'], ['FR1', 'FR', 'France'],
  ['GR1', 'GR', 'Greece'], ['HK1', 'HK', 'Hong Kong'], ['HR1', 'HR', 'Croatia'], ['HU1', 'HU', 'Hungary'], ['ID1', 'ID', 'Indonesia'],
  ['IE1', 'IE', 'Ireland'], ['IL1', 'IL', 'Israel'], ['IN1', 'IN', 'India'], ['IN2', 'IN', 'India'], ['IN4', 'IN', 'India'], ['IT1', 'IT', 'Italy'],
  ['JM1', 'JM', 'Jamaica'], ['JP1', 'JP', 'Japan'], ['JP2', 'JP', 'Japan'], ['KE1', 'KE', 'Kenya'], ['KR1', 'KR', 'South Korea'],
  ['KZ1', 'KZ', 'Kazakhstan'], ['LT1', 'LT', 'Lithuania'], ['LU1', 'LU', 'Luxembourg'], ['LV1', 'LV', 'Latvia'], ['MN1', 'MN', 'Mongolia'],
  ['MT1', 'MT', 'Malta'], ['MX1', 'MX', 'Mexico'], ['MY1', 'MY', 'Malaysia'], ['NG1', 'NG', 'Nigeria'], ['NL1', 'NL', 'Netherlands'],
  ['NO1', 'NO', 'Norway'], ['NZ1', 'NZ', 'New Zealand'], ['PA1', 'PA', 'Panama'], ['PE1', 'PE', 'Peru'], ['PH2', 'PH', 'Philippines'],
  ['PL1', 'PL', 'Poland'], ['PT1', 'PT', 'Portugal'], ['RO1', 'RO', 'Romania'], ['RO2', 'RO', 'Romania'], ['RS1', 'RS', 'Serbia'],
  ['SA2', 'SA', 'Saudi Arabia'], ['SE1', 'SE', 'Sweden'], ['SG1', 'SG', 'Singapore'], ['SK1', 'SK', 'Slovakia'], ['SV1', 'SV', 'El Salvador'],
  ['TH1', 'TH', 'Thailand'], ['TR1', 'TR', 'Turkey'], ['TR3', 'TR', 'Turkey'], ['UA1', 'UA', 'Ukraine'], ['UK1', 'GB', 'United Kingdom'],
  ['US2', 'US', 'United States'], ['US_LOCALS1', 'US', 'United States (locals)'], ['US_SPORTS1', 'US', 'United States (sports)'],
  ['UY1', 'UY', 'Uruguay'], ['VN1', 'VN', 'Vietnam'], ['ZA1', 'ZA', 'South Africa'],
];

export const presetId = (file: string) => `epgshare01-${file.toLowerCase()}`;
export const EPGSHARE_PRESETS: EpgPreset[] = FILES.map(([file, country, name]) => ({
  id: presetId(file), provider: 'epgshare01', country, countryName: name, name: `epgshare01 · ${name} (${file})`, url: `${EPGSHARE_BASE}epg_ripper_${file}.xml.gz`,
}));

/** "Antena 1 HD", "Antena.1.HD.ro" → "antena1hd" (accents, punctuation and the country suffix dropped). */
export function nameKey(s: string): string {
  return s
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\.[a-z]{2}$/i, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
}
/** Both the name and the name without a trailing HD/SD/FHD: tuners and guides disagree about it. */
const keysOf = (s: string) => {
  const k = nameKey(s);
  const bare = k.replace(/(fhd|uhd|hd|sd|4k)$/, '');
  return bare && bare !== k ? [k, bare] : [k];
};

/** How many of `channelNames` a guide's channel list (the .txt) carries. */
export function scoreList(channelNames: string[], listText: string): number {
  const ids = new Set<string>();
  for (const line of listText.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('--') || /^\d+$/.test(l)) continue;
    for (const k of keysOf(l)) ids.add(k);
  }
  let n = 0;
  for (const name of new Set(channelNames)) if (keysOf(name).some((k) => ids.has(k))) n++;
  return n;
}

/** The files worth adding: enough matches, and close to the best one (a country often has two files). */
export function pickFiles(scores: { file: string; score: number }[], channelCount: number): string[] {
  const best = Math.max(0, ...scores.map((s) => s.score));
  const min = Math.max(3, Math.ceil(channelCount * 0.05));
  if (best < min) return [];
  return scores.filter((s) => s.score >= min && s.score >= best * 0.25).sort((a, b) => b.score - a.score).slice(0, 4).map((s) => s.file);
}

type Fetcher = (url: string) => Promise<string>;
const defaultFetch: Fetcher = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Vibe media server)' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

/** Score every country file against the live channels (TV only; radio rarely has a guide). */
export async function detectFiles(fetcher: Fetcher = defaultFetch): Promise<{ file: string; score: number }[]> {
  const names = db.all<{ name: string }>(
    `SELECT COALESCE(json_extract(c.custom, '$.name'), c.name) name FROM channels c JOIN live_sources s ON s.id = c.source_id
     WHERE s.enabled = 1 AND c.hidden = 0 AND COALESCE(json_extract(c.custom, '$.radio'), c.radio, 0) = 0`).map((r) => r.name);
  if (!names.length) return [];
  const scores: { file: string; score: number }[] = [];
  const queue = [...FILES];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      try {
        scores.push({ file: f[0], score: scoreList(names, await fetcher(`${EPGSHARE_BASE}epg_ripper_${f[0]}.txt`)) });
      } catch (e) {
        log.debug?.(`epgshare01 ${f[0]}: ${(e as Error).message}`);
      }
    }
  }));
  const picked = new Set(pickFiles(scores, new Set(names).size));
  return scores.filter((s) => picked.has(s.file)).sort((a, b) => b.score - a.score);
}

const KV = 'epgshare01.auto';
const hasEpgshareSource = () => db.all<{ config: string }>("SELECT config FROM epg_sources WHERE kind = 'xmltv'").some((r) => r.config.includes('epgshare01'));

/**
 * Add the epgshare01 files that carry the live channels as guide sources. `auto`: only once per server (after the
 * first live source sync with channels) and never while an epgshare01 guide exists; manual runs always look.
 */
export async function setupEpgshare(
  create: (preset: EpgPreset) => Promise<unknown>,
  opts: { auto?: boolean; fetcher?: Fetcher } = {},
): Promise<{ added: string[]; scores: { file: string; score: number }[] }> {
  if (opts.auto && (getKv<{ done?: boolean }>(KV, {}).done || hasEpgshareSource())) return { added: [], scores: [] };
  const scores = await detectFiles(opts.fetcher);
  if (opts.auto && !scores.length) return { added: [], scores }; // nothing matched (yet): try again after the next sync
  const existing = db.all<{ config: string }>("SELECT config FROM epg_sources WHERE kind = 'xmltv'").map((r) => r.config);
  const added: string[] = [];
  for (const { file } of scores) {
    const p = EPGSHARE_PRESETS.find((x) => x.id === presetId(file))!;
    if (existing.some((c) => c.includes(p.url) || c.includes(`"${p.id}"`))) continue;
    await create(p);
    added.push(file);
  }
  setKv(KV, { done: true, at: new Date().toISOString(), files: scores.map((s) => s.file) });
  if (added.length) log.info(`Added epgshare01 guides: ${added.join(', ')}`);
  return { added, scores };
}
