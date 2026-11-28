/**
 * Channel surfing like a TV: the list you flick through (same kind as what's on: TV or radio; favourites only when
 * asked and there are some), stepping with wrap-around, and number entry that previews the channel as you type.
 */

export interface SurfChannel {
  id: string;
  number: number | null;
  name: string;
  radio?: boolean;
  favorite?: boolean;
}

/** The channels up/down moves through while `current` is on. */
export function surfList<C extends SurfChannel>(all: C[], current: Pick<SurfChannel, 'id' | 'radio'> | null, favOnly: boolean): C[] {
  const sameKind = all.filter((c) => !!c.radio === !!current?.radio);
  const list = sameKind.length ? sameKind : all;
  if (!favOnly) return list;
  const favs = list.filter((c) => c.favorite || c.id === current?.id);
  return favs.some((c) => c.favorite) ? favs : list;
}

/** The channel `dir` steps from `fromId` (wraps around; from an unknown channel, the first or last). */
export function stepChannel<C extends SurfChannel>(list: C[], fromId: string, dir: 1 | -1): C | null {
  if (!list.length) return null;
  const i = list.findIndex((c) => c.id === fromId);
  if (i < 0) return dir > 0 ? list[0]! : list[list.length - 1]!;
  return list[(i + dir + list.length) % list.length]!;
}

/** Number entry: the channel with exactly this number, else the first whose number starts with it (what you'll get if you keep typing). */
export function matchNumber<C extends SurfChannel>(list: C[], typed: string): { exact: C | null; preview: C | null } {
  const exact = list.find((c) => c.number != null && String(c.number) === typed) ?? null;
  const preview = exact ?? list.find((c) => c.number != null && String(c.number).startsWith(typed)) ?? null;
  return { exact, preview };
}

/** "12 · Pro TV" */
export const channelLabel = (c: Pick<SurfChannel, 'number' | 'name'>) => `${c.number != null ? `${c.number} · ` : ''}${c.name}`;

/** Time to rest on a channel while surfing before it is tuned (tuning each one would churn the tuners). */
export const SURF_TUNE_MS = 800;
/** How long the channel banner stays up after a change. */
export const BANNER_MS = 5000;
