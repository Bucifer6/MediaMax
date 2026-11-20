/**
 * Built-in profile avatars: simple, original SVG faces (no third-party characters). Served by GET /avatars/:id.svg
 * without authentication so every client (web, TV, phone) can show them in the "Who's watching?" picker.
 */
import type { BuiltinAvatar } from '@mediamax/shared';

const eyes = (y = 52, dx = 18, r = 6, fill = '#1b1b2f') => `<circle cx="${60 - dx}" cy="${y}" r="${r}" fill="${fill}"/><circle cx="${60 + dx}" cy="${y}" r="${r}" fill="${fill}"/>`;
const smile = (y = 70, w = 18, stroke = '#1b1b2f') => `<path d="M${60 - w} ${y} Q60 ${y + w} ${60 + w} ${y}" fill="none" stroke="${stroke}" stroke-width="6" stroke-linecap="round"/>`;

interface Def { id: string; name: string; bg: string; body: string }

const DEFS: Def[] = [
  { id: 'sunny', name: 'Sunny', bg: '#f5b700', body: `<circle cx="60" cy="62" r="34" fill="#ffe066"/>${eyes(56, 13, 5)}${smile(70, 14)}` },
  { id: 'cat', name: 'Cat', bg: '#ff7a59', body: `<path d="M28 44 L36 18 L52 36 Z M92 44 L84 18 L68 36 Z" fill="#ffd6c7"/><circle cx="60" cy="64" r="34" fill="#ffd6c7"/>${eyes(58, 14, 5)}<path d="M55 70 L65 70 L60 76 Z" fill="#e8505b"/><path d="M30 72 H46 M30 80 H46 M74 72 H90 M74 80 H90" stroke="#1b1b2f" stroke-width="2.5" stroke-linecap="round"/>` },
  { id: 'robot', name: 'Robot', bg: '#4361ee', body: `<rect x="56" y="14" width="8" height="14" rx="3" fill="#e0e7ff"/><circle cx="60" cy="13" r="6" fill="#ffd166"/><rect x="26" y="30" width="68" height="60" rx="14" fill="#e0e7ff"/><rect x="36" y="44" width="48" height="18" rx="9" fill="#1b1b2f"/><circle cx="48" cy="53" r="5" fill="#06d6a0"/><circle cx="72" cy="53" r="5" fill="#06d6a0"/><rect x="44" y="72" width="32" height="6" rx="3" fill="#8d99ae"/>` },
  { id: 'alien', name: 'Alien', bg: '#7b2cbf', body: `<ellipse cx="60" cy="62" rx="32" ry="38" fill="#80ed99"/><ellipse cx="46" cy="58" rx="9" ry="13" fill="#1b1b2f" transform="rotate(-20 46 58)"/><ellipse cx="74" cy="58" rx="9" ry="13" fill="#1b1b2f" transform="rotate(20 74 58)"/>${smile(80, 9)}` },
  { id: 'owl', name: 'Owl', bg: '#2a9d8f', body: `<path d="M26 40 L40 28 L60 36 L80 28 L94 40 L94 82 Q60 104 26 82 Z" fill="#c9a66b"/><circle cx="45" cy="56" r="13" fill="#fff"/><circle cx="75" cy="56" r="13" fill="#fff"/>${eyes(56, 15, 6)}<path d="M55 68 L65 68 L60 78 Z" fill="#f4a261"/>` },
  { id: 'bear', name: 'Bear', bg: '#8d6e63', body: `<circle cx="34" cy="36" r="12" fill="#d7b49e"/><circle cx="86" cy="36" r="12" fill="#d7b49e"/><circle cx="60" cy="62" r="34" fill="#d7b49e"/><ellipse cx="60" cy="74" rx="15" ry="11" fill="#f1e3d3"/>${eyes(56, 14, 5)}<ellipse cx="60" cy="70" rx="6" ry="4" fill="#1b1b2f"/>` },
  { id: 'panda', name: 'Panda', bg: '#90be6d', body: `<circle cx="34" cy="36" r="12" fill="#1b1b2f"/><circle cx="86" cy="36" r="12" fill="#1b1b2f"/><circle cx="60" cy="62" r="34" fill="#fff"/><ellipse cx="46" cy="58" rx="9" ry="11" fill="#1b1b2f"/><ellipse cx="74" cy="58" rx="9" ry="11" fill="#1b1b2f"/>${eyes(57, 14, 3, '#fff')}<ellipse cx="60" cy="72" rx="5" ry="3.5" fill="#1b1b2f"/>` },
  { id: 'ghost', name: 'Ghost', bg: '#3a0ca3', body: `<path d="M30 92 V56 Q30 26 60 26 Q90 26 90 56 V92 L80 84 L70 92 L60 84 L50 92 L40 84 Z" fill="#f8f9fa"/>${eyes(54, 12, 6)}<ellipse cx="60" cy="70" rx="6" ry="8" fill="#1b1b2f"/>` },
  { id: 'planet', name: 'Planet', bg: '#03045e', body: `<circle cx="22" cy="26" r="2" fill="#fff"/><circle cx="96" cy="20" r="2.5" fill="#fff"/><circle cx="98" cy="96" r="2" fill="#fff"/><circle cx="60" cy="60" r="26" fill="#f72585"/><ellipse cx="60" cy="62" rx="44" ry="11" fill="none" stroke="#ffd166" stroke-width="6" transform="rotate(-15 60 62)"/>${eyes(56, 9, 3.5)}${smile(64, 7)}` },
  { id: 'monster', name: 'Monster', bg: '#06d6a0', body: `<path d="M36 34 L42 18 L48 34 M72 34 L78 18 L84 34" fill="#fff"/><rect x="26" y="30" width="68" height="64" rx="30" fill="#118ab2"/><circle cx="60" cy="54" r="14" fill="#fff"/><circle cx="60" cy="54" r="6" fill="#1b1b2f"/><path d="M42 76 Q60 90 78 76 Z" fill="#1b1b2f"/><path d="M50 77 L54 83 L58 78 M62 78 L66 83 L70 77" fill="#fff"/>` },
  { id: 'penguin', name: 'Penguin', bg: '#48cae4', body: `<ellipse cx="60" cy="64" rx="32" ry="36" fill="#1b1b2f"/><ellipse cx="60" cy="70" rx="22" ry="26" fill="#fff"/>${eyes(56, 10, 4)}<path d="M53 64 L67 64 L60 72 Z" fill="#ff9f1c"/>` },
  { id: 'star', name: 'Star', bg: '#ef476f', body: `<path d="M60 18 L71 46 L101 47 L77 66 L86 95 L60 78 L34 95 L43 66 L19 47 L49 46 Z" fill="#ffd166" stroke="#ffd166" stroke-width="4" stroke-linejoin="round"/>${eyes(58, 9, 4)}${smile(66, 8)}` },
];

const svg = (d: Def) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="240" height="240"><rect width="120" height="120" rx="24" fill="${d.bg}"/>${d.body}</svg>`;

export const AVATAR_IDS = DEFS.map((d) => d.id);
export const isBuiltinAvatar = (id: unknown): id is string => typeof id === 'string' && AVATAR_IDS.includes(id);
export const builtinAvatarUrl = (id: string) => `/api/v1/avatars/${id}.svg`;
export const avatarColor = (id: string) => DEFS.find((d) => d.id === id)?.bg ?? null;

export function listAvatars(): BuiltinAvatar[] {
  return DEFS.map((d) => ({ id: d.id, name: d.name, url: builtinAvatarUrl(d.id), color: d.bg }));
}

export function avatarSvg(id: string): string | null {
  const d = DEFS.find((x) => x.id === id);
  return d ? svg(d) : null;
}
