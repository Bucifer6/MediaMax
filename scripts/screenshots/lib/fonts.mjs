import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Downloads a handful of Google Fonts (through curl, so an HTTPS proxy in the environment just works) and returns
 * @font-face CSS pointing at the local files. Without network the CSS is empty and the templates fall back to the
 * system fonts listed after each family.
 */
const FAMILIES = [
  'Orbitron:wght@700;900', 'Bebas+Neue', 'Playfair+Display:ital,wght@0,700;0,900;1,700', 'DM+Serif+Display:ital@0;1',
  'Cormorant+Garamond:ital,wght@0,500;0,700;1,500', 'Fredoka:wght@600;700', 'Cinzel:wght@600;800', 'Lilita+One',
  'Monoton', 'Caveat:wght@600', 'Space+Grotesk:wght@500;700', 'Oswald:wght@400;600', 'Libre+Baskerville:ital@0;1', 'Archivo+Black',
];

function curl(url, out) {
  const args = ['-sSfL', '--max-time', '15'];
  if (out) args.push('-o', out);
  return execFileSync('curl', [...args, url], { encoding: out ? undefined : 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

export function prepareFonts(dir, log = () => {}) {
  fs.mkdirSync(dir, { recursive: true });
  let css;
  try {
    css = curl(`https://fonts.googleapis.com/css2?${FAMILIES.map((f) => `family=${f}`).join('&')}&display=block`);
  } catch {
    log('Google Fonts not reachable, using system fonts.');
    return '';
  }
  const faces = [];
  const blocks = css.match(/@font-face\s*{[^}]+}/g) ?? [];
  let n = 0;
  for (const block of blocks) {
    const url = block.match(/url\((https:[^)]+)\)/)?.[1];
    if (!url) continue;
    const file = path.join(dir, `f${n++}${path.extname(new URL(url).pathname) || '.ttf'}`);
    try {
      if (!fs.existsSync(file)) curl(url, file);
      faces.push(block.replace(url, 'file://' + file));
    } catch {
      /* skip this face */
    }
  }
  log(`Fonts: ${faces.length} faces downloaded.`);
  return faces.join('\n');
}
