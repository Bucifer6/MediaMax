/**
 * TV helpers. The phone build compiles against stock react-native, the TV
 * build swaps in react-native-tvos (see README). TV-only APIs are therefore
 * looked up at runtime so this file type-checks and runs on both.
 */
import React, { useEffect, useRef, useState } from 'react';
import * as RN from 'react-native';
import { BackHandler, Platform, View, type ViewProps } from 'react-native';

export interface TVRemoteEvent {
  eventType:
    | 'up' | 'down' | 'left' | 'right' | 'select' | 'playPause' | 'menu'
    | 'longUp' | 'longDown' | 'longLeft' | 'longRight' | 'longSelect'
    | 'fastForward' | 'rewind' | 'pageUp' | 'pageDown' | 'channelUp' | 'channelDown'
    | 'swipeUp' | 'swipeDown' | 'swipeLeft' | 'swipeRight' | 'focus' | 'blur' | string;
  eventKeyAction?: number;
  tag?: number;
}

type TVModule = {
  useTVEventHandler?: (handler: (evt: TVRemoteEvent) => void) => void;
  TVEventControl?: {
    enableTVMenuKey?: () => void;
    disableTVMenuKey?: () => void;
    enableTVPanGesture?: () => void;
    disableTVPanGesture?: () => void;
  };
  TVFocusGuideView?: React.ComponentType<ViewProps & { autoFocus?: boolean; trapFocusUp?: boolean; trapFocusDown?: boolean; trapFocusLeft?: boolean; trapFocusRight?: boolean; destinations?: unknown[] }>;
};

const tv = RN as unknown as TVModule;
const noopHook = (_: (evt: TVRemoteEvent) => void) => undefined;

export const isTV = Platform.isTV;

/** Subscribe to remote-control events (D-pad, play/pause, swipes). No-op off TV. */
export const useTVEventHandlerSafe: (handler: (evt: TVRemoteEvent) => void) => void =
  isTV && typeof tv.useTVEventHandler === 'function' ? tv.useTVEventHandler : noopHook;

export function useTVRemote(handler: (evt: TVRemoteEvent) => void, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useTVEventHandlerSafe((evt) => {
    if (!enabled || !evt) return;
    // Android TV fires both key-down (0) and key-up (1); act on key-up only.
    if (evt.eventKeyAction === 0) return;
    ref.current(evt);
  });
}

/*
 * tvOS: the Menu button exits the app unless the "menu key" is enabled. We
 * enable it whenever there is somewhere to go back to (root layout passes
 * canGoBack) or a screen is holding it (useBackHandler), so Menu behaves like
 * Back inside the app and like Home at the top level.
 */
let menuHolders = 0;
const holderListeners = new Set<() => void>();
function setHolders(delta: number) {
  menuHolders += delta;
  holderListeners.forEach((l) => l());
}

export function useTVMenuKeyManager(canGoBack: boolean) {
  const [holders, setH] = useState(menuHolders);
  useEffect(() => {
    const l = () => setH(menuHolders);
    holderListeners.add(l);
    return () => {
      holderListeners.delete(l);
    };
  }, []);
  const enabled = canGoBack || holders > 0;
  useEffect(() => {
    if (!isTV || Platform.OS !== 'ios') return;
    if (enabled) tv.TVEventControl?.enableTVMenuKey?.();
    else tv.TVEventControl?.disableTVMenuKey?.();
  }, [enabled]);
}

/** Hardware back (Android, Android TV) and tvOS Menu. Return true to consume. */
export function useBackHandler(handler: () => boolean, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    setHolders(1);
    const sub = BackHandler.addEventListener('hardwareBackPress', () => ref.current());
    return () => {
      setHolders(-1);
      sub.remove();
    };
  }, [enabled]);
}

/** Focus guide (keeps D-pad focus inside a region); plain View off TV. */
export function FocusGuide(props: ViewProps & { autoFocus?: boolean; trapFocusUp?: boolean; trapFocusDown?: boolean; trapFocusLeft?: boolean; trapFocusRight?: boolean }) {
  const Guide = isTV ? tv.TVFocusGuideView : undefined;
  if (Guide) return <Guide {...props} />;
  const { autoFocus: _a, trapFocusUp: _u, trapFocusDown: _d, trapFocusLeft: _l, trapFocusRight: _r, ...rest } = props;
  return <View {...rest} />;
}
