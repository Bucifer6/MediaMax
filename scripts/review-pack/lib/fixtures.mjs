/**
 * Text fixtures the review server serves next to the media: the podcast RSS feed, the Live TV playlist (M3U) and
 * the programme guide (XMLTV). They hold absolute URLs and dates, so the seeder writes them when it runs (with the
 * address the Kinora container uses to reach the fixtures service) rather than the build baking them in.
 *
 * No dependencies: this file is copied into the review pack and runs inside the Kinora container.
 */

export const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const trimSlash = (u) => String(u).replace(/\/+$/, '');

/** RFC 822 date for RSS. */
export const rfc822 = (d) => new Date(d).toUTCString().replace('GMT', '+0000');

/** XMLTV timestamp: YYYYMMDDHHMMSS +0000. */
export function xmltvTime(d) {
  const t = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())} +0000`;
}

const hms = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Podcast RSS 2.0 feed with the iTunes tags Kinora reads.
 * `show`: { title, author, description, language, link? }, `episodes`: [{ n, title, date, description, file, bytes, seconds }]
 * `base`: URL of the folder holding cover.jpg and the episode files.
 */
export function podcastFeed({ base, show, episodes }) {
  const b = trimSlash(base);
  const items = [...episodes].sort((x, y) => new Date(y.date) - new Date(x.date)).map((e) => `    <item>
      <title>${xml(e.title)}</title>
      <description>${xml(e.description ?? e.title)}</description>
      <guid isPermaLink="false">${xml(`${show.slug ?? 'kinora-notes'}-${e.n}`)}</guid>
      <pubDate>${rfc822(e.date)}</pubDate>
      <enclosure url="${xml(`${b}/${encodeURIComponent(e.file)}`)}" length="${e.bytes ?? 0}" type="audio/mpeg"/>
      <itunes:episode>${e.n}</itunes:episode>
      <itunes:duration>${hms(e.seconds ?? 0)}</itunes:duration>
      <itunes:explicit>false</itunes:explicit>
    </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${xml(show.title)}</title>
    <link>${xml(show.link ?? b + '/')}</link>
    <description>${xml(show.description)}</description>
    <language>${xml(show.language ?? 'en')}</language>
    <copyright>CC0 1.0: dedicated to the public domain by the Kinora project</copyright>
    <itunes:author>${xml(show.author)}</itunes:author>
    <itunes:image href="${xml(`${b}/cover.jpg`)}"/>
    <itunes:explicit>false</itunes:explicit>
    <itunes:category text="Technology"/>
${items}
  </channel>
</rss>
`;
}

/**
 * Extended M3U for the generated test channels. `streamBase`: folder holding <id>/index.m3u8 (the looping HLS the
 * testcard service writes); `logoBase`: folder holding <id>.png.
 */
export function m3uPlaylist({ streamBase, logoBase, guideUrl, channels }) {
  const head = `#EXTM3U${guideUrl ? ` url-tvg="${guideUrl}"` : ''}`;
  const lines = channels.map((c) => `#EXTINF:-1 tvg-id="${c.id}" tvg-name="${c.name}" tvg-chno="${c.number}" tvg-logo="${trimSlash(logoBase)}/${c.id}.png" group-title="${c.group}",${c.name}\n${trimSlash(streamBase)}/${c.id}/index.m3u8`);
  return [head, ...lines].join('\n') + '\n';
}

/**
 * XMLTV guide: back-to-back programmes for each channel from `hoursBack` before `now` to `days` ahead, in blocks of
 * `blockMinutes`, aligned to the block boundary so the guide grid looks tidy.
 */
export function xmltvGuide({ channels, now = Date.now(), days = 7, hoursBack = 6, blockMinutes = 30 }) {
  const block = blockMinutes * 60000;
  const start = Math.floor((now - hoursBack * 3600000) / block) * block;
  const end = start + hoursBack * 3600000 + days * 86400000;
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="Kinora review pack">'];
  for (const c of channels) out.push(`  <channel id="${xml(c.id)}"><display-name>${xml(c.name)}</display-name></channel>`);
  for (const c of channels) {
    let i = 0;
    for (let t = start; t < end; t += block, i++) {
      const title = c.programmes[i % c.programmes.length];
      out.push(`  <programme start="${xmltvTime(t)}" stop="${xmltvTime(t + block)}" channel="${xml(c.id)}">
    <title lang="en">${xml(title)}</title>
    <desc lang="en">${xml(`${title}: a generated test programme on ${c.name}. No real broadcast content.`)}</desc>
    <category lang="en">Test</category>
  </programme>`);
    }
  }
  out.push('</tv>');
  return out.join('\n') + '\n';
}
