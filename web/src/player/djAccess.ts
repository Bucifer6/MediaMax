/**
 * Is the advanced DJ (DJ page, AI DJ prompt and voice host, DJ entry points) shown for this listener?
 * Off by default (the lite DJ is Automix in the normal player). Listeners who already used DJ mode in this browser
 * (its settings are saved locally) keep it until they turn it off. Kept apart from djEngine so checking it never
 * loads the DJ engine or the AI DJ.
 */
import type { User } from '@mediamax/shared';

export function usedDjBefore(): boolean {
  try {
    return localStorage.getItem('mm.dj.mixer') != null || localStorage.getItem('mm.dj.voice') != null;
  } catch {
    return false;
  }
}

export function advancedDjEnabled(user: Pick<User, 'preferences'> | null | undefined): boolean {
  const v = user?.preferences?.advancedDj;
  return v ?? usedDjBefore();
}
