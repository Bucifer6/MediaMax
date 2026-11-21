// Local subtitle folder — an example subtitle-provider plugin (ctx.subtitles.registerProvider).
// Kinora scores each result against the media file name, unpacks archives, fixes encoding/diacritics and saves it.
import fs from 'node:fs';
import path from 'node:path';

const EXT = /\.(srt|ass|ssa|vtt|zip|rar|7z)$/i;
const LANG = /[._ -](ro|rum|ron|en|eng|fr|fre|de|ger|es|spa|it|ita|hu|hun)(?=[._ -]|\.\w+$)/i;
const TO2 = { rum: 'ro', ron: 'ro', eng: 'en', fre: 'fr', ger: 'de', spa: 'es', ita: 'it', hun: 'hu' };

/** @type {import('../../sdk/index').ActivateFn} */
export async function activate(ctx) {
  const root = () => String(ctx.settings.get('folder') || '');

  /** All candidate files under the folder (relative paths), depth-limited. */
  function listFiles(dir, depth = 0, out = []) {
    if (depth > 5 || out.length > 20000) return out;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) listFiles(p, depth + 1, out);
      else if (EXT.test(e.name)) out.push(path.relative(root(), p));
    }
    return out;
  }

  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

  ctx.subtitles.registerProvider({
    id: 'folder',
    name: 'Local folder',
    configured: () => !!root() && fs.existsSync(root()),
    async search(q) {
      const imdb = (q.item.type === 'episode' ? q.showImdbId : q.imdbId)?.toLowerCase();
      const title = norm(q.title);
      const wanted = new Set(q.languages);
      return listFiles(root()).filter((rel) => {
        const low = rel.toLowerCase();
        return (imdb && low.includes(imdb)) || (title.length >= 3 && norm(rel).includes(title));
      }).map((rel) => {
        const m = path.basename(rel).match(LANG);
        const raw = m ? m[1].toLowerCase() : String(ctx.settings.get('defaultLanguage') || 'ro');
        return { id: Buffer.from(rel).toString('base64url'), language: TO2[raw] ?? raw, release: path.basename(rel), fileName: path.basename(rel) };
      }).filter((r) => wanted.has(r.language)).slice(0, 100);
    },
    async download(r) {
      const rel = Buffer.from(r.id, 'base64url').toString('utf8');
      const file = path.resolve(root(), rel);
      if (!file.startsWith(path.resolve(root()) + path.sep)) throw new Error('Invalid subtitle id');
      return { data: fs.readFileSync(file), fileName: path.basename(file) };
    },
  });
}
