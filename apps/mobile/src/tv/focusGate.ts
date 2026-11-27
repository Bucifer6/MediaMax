/**
 * When `hasTVPreferredFocus` may actually take focus on TV.
 *
 * Tab screens stay mounted behind the active one, and several of them mark an element as preferred
 * (Home's first card, Search's input, Settings' first row...). Without a gate, a hidden screen that
 * re-renders (Home after its data loads) pulls focus into a view that cannot hold it, Android drops
 * focus onto the first focusable view (the Home tab), and the top bar's switch-on-focus jumps back to
 * Home. A screen opened by resting on a tab would likewise yank focus out of the bar.
 *
 * So preferred focus applies only on the focused screen, and not when the screen (or the element)
 * appeared while the tab bar held focus: then the user is browsing tabs and pressing DOWN takes them
 * into the screen as usual. The decision is taken when the element mounts or its screen gains focus,
 * not on every bar blur/focus, so moving between tabs (blur of one, focus of the next) can't let a
 * screen grab focus in between.
 */
import { NavigationContext } from 'expo-router/react-navigation';
import { useContext, useEffect, useState } from 'react';

let tabBarFocused = false;

/** Called by the TV tab bar as its items gain and lose focus. */
export function setTabBarFocused(value: boolean) {
  tabBarFocused = value;
}

/** `wanted`, limited to the focused screen and to elements that didn't appear while the tab bar had focus. */
export function usePreferredFocus(wanted: boolean | undefined): boolean {
  const nav = useContext(NavigationContext);
  const [screenFocused, setScreenFocused] = useState(() => nav?.isFocused() ?? true);
  const [suppressed, setSuppressed] = useState(() => tabBarFocused);
  useEffect(() => {
    if (!nav) return;
    setScreenFocused(nav.isFocused());
    const offFocus = nav.addListener('focus', () => {
      setSuppressed(tabBarFocused);
      setScreenFocused(true);
    });
    const offBlur = nav.addListener('blur', () => setScreenFocused(false));
    return () => {
      offFocus();
      offBlur();
    };
  }, [nav]);
  return !!wanted && screenFocused && !suppressed;
}
